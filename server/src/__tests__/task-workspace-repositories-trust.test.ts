import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, executionWorkspaceRepositories, executionWorkspaces,
  heartbeatRuns, issues, projects, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { executionWorkspaceRepositoryService } from "../services/execution-workspace-repositories.js";
import { buildGitAuthInvocation } from "../services/git-credentials.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const acquisition = vi.hoisted(() => ({ managedAuth: vi.fn(), materialize: vi.fn(), catalog: vi.fn() }));
vi.mock("../services/tool-access.js", () => ({ toolAccessService: () => ({ listProjectRepositories: acquisition.catalog }) }));
vi.mock("../services/git-credentials.js", async (original) => ({
  ...await original<typeof import("../services/git-credentials.js")>(),
  createGitRemoteAuthProvider: () => acquisition.managedAuth,
}));
vi.mock("../services/managed-repository-checkout.js", async (original) => ({
  ...await original<typeof import("../services/managed-repository-checkout.js")>(),
  materializeManagedProjectWorkspace: acquisition.materialize,
}));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("task repository trust authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-repository-trust-");
    db = createDb(database.connectionString);
    root = await mkdtemp(path.join(tmpdir(), "paperclip-repository-trust-"));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.clearAllMocks(); });
  afterAll(async () => { await database?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const userId = randomUUID(), cwd = path.join(root, issueId);
    await mkdir(cwd);
    await db.insert(companies).values({ id: companyId, name: "Repository trust", issuePrefix: `R${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(authUsers).values({ id: userId, name: "Sponsor", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat worker", adapterType: "process", status: "idle" });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
    ]);
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Task files", cwd,
      mode: "isolated_workspace", strategyType: "task_directory" }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Unlinked chat work", assigneeAgentId: agentId,
      executionWorkspaceId: workspace.id });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId,
      contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    acquisition.catalog.mockResolvedValue({ repositories: [{ id: "private-repo", fullName: "sponsor/private", private: true,
      url: "https://github.com/sponsor/private", connections: ["sponsor-github"] }] });
    acquisition.managedAuth.mockRejectedValue(new Error("Managed credentials must not be acquired"));
    const actor = { type: "agent" as const, source: "agent_jwt" as const, companyId, agentId, runId, onBehalfOfUserId: userId };
    const policy = { trustPreset: "low_trust_review" as const, authorizationPolicy: {
      trustPreset: "low_trust_review" as const, trustBoundary: { mode: "low_trust_review" as const, companyId, rootIssueId: issueId },
    } };
    const service = executionWorkspaceRepositoryService(db);
    const request = (repository: { kind: "catalog"; id: string } | { kind: "url"; url: string }, requestKey = randomUUID()) =>
      service.request({ companyId, issueId, actor, request: { repository, requestKey } });
    const admission = { companyId, issueId, workspaceId: workspace.id, cwd, agentId, runId, responsibleUserId: userId };
    return { companyId, agentId, issueId, runId, userId, workspace, policy, service, actor, request, admission };
  }

  it.each(["agent", "issue", "project", "workspace_source_project", "run"] as const)(
    "rejects catalog acquisition from raw %s low-trust policy", async source => {
      const f = await fixture();
      if (source === "agent") await db.update(agents).set({ permissions: f.policy }).where(eq(agents.id, f.agentId));
      if (source === "issue") await db.update(issues).set({ executionPolicy: f.policy }).where(eq(issues.id, f.issueId));
      if (source === "run") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
      if (source === "project" || source === "workspace_source_project") {
        const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Restricted", executionWorkspacePolicy: f.policy }).returning();
        if (source === "project") await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
        else {
          await db.update(projects).set({ executionWorkspacePolicy: { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy,
            trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, projectIds: [project.id] } } } }).where(eq(projects.id, project.id));
          await db.update(executionWorkspaces).set({ projectId: project.id, strategyType: "git_worktree" }).where(eq(executionWorkspaces.id, f.workspace.id));
        }
      }
      await expect(f.request({ kind: "catalog", id: "private-repo" })).rejects.toThrow(/anonymous public URLs only/);
      expect(await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.companyId, f.companyId))).toHaveLength(0);
      expect(acquisition.managedAuth).not.toHaveBeenCalled();
    },
  );

  it("keeps a URL matching the sponsor's private catalog anonymous under retained run trust", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    const receipt = await f.request({ kind: "url", url: "https://github.com/sponsor/private" });
    expect(receipt.repository.catalogRepositoryId).toBeNull();
    acquisition.materialize.mockImplementationOnce(async (_cwd, input) => {
      const auth = await input.resolveGitAuth(input.repoUrl);
      expect(auth).toEqual({ ...buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null }),
        env: expect.objectContaining({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }) });
      throw new Error("Anonymous remote rejects private repository");
    });
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow("Anonymous remote rejects private repository");
    expect(acquisition.materialize).toHaveBeenCalledOnce();
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
    const [stored] = await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.id, receipt.operationId));
    expect(stored).toMatchObject({ catalogRepositoryId: null, state: "needs_repair" });
  });

  it.each(["pending", "ready"] as const)("blocks a %s managed receipt after the run becomes low trust", async state => {
    const f = await fixture();
    const receipt = await f.request({ kind: "catalog", id: "private-repo" });
    await db.update(executionWorkspaceRepositories).set({ state, pinnedCommit: state === "ready" ? "a".repeat(40) : null })
      .where(eq(executionWorkspaceRepositories.id, receipt.operationId));
    const checkout = path.join(f.admission.cwd, receipt.repository.relativePath);
    if (state === "ready") { await mkdir(checkout, { recursive: true }); await writeFile(path.join(checkout, "private.txt"), "retained private bytes"); }
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.request({ kind: "url", url: receipt.repository.repoUrl })).rejects.toThrow(/anonymous public URLs only/);
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow(/anonymous public URLs only/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
    if (state === "ready") expect(await readFile(path.join(checkout, "private.txt"), "utf8")).toBe("retained private bytes");
  });

  it("prepares an anonymous public URL through actual local Git materialization", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    const receipt = await f.request({ kind: "url", url: "https://github.com/public/example" });
    const source = path.join(root, `${f.issueId}-public-source`);
    await mkdir(source);
    const exec = promisify(execFileCallback);
    await exec("git", ["init", "--initial-branch=main", source]);
    await writeFile(path.join(source, "public.txt"), "Public fixture bytes\n");
    await exec("git", ["-C", source, "add", "."]);
    await exec("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "public source"]);
    const actual = await vi.importActual<typeof import("../services/managed-repository-checkout.js")>("../services/managed-repository-checkout.js");
    acquisition.materialize.mockImplementationOnce(async (cwd, input) => {
      const auth = await input.resolveGitAuth(input.repoUrl);
      expect(auth.env).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
      expect(auth.configArgs).toEqual(buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null }).configArgs);
      const result = await actual.materializeManagedProjectWorkspace(cwd, { ...input, localSource: source });
      await exec("git", ["-C", cwd, "remote", "set-url", "origin", input.repoUrl]);
      return result;
    });
    const [prepared] = await f.service.prepareForAdmission(f.admission);
    expect(prepared.id).toBe(receipt.operationId);
    expect(await readFile(path.join(prepared.cwd, "public.txt"), "utf8")).toBe("Public fixture bytes\n");
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
  });

  it.each(["same_repository", "different_repository", "empty_inventory", "unpinned_publication"] as const)(
    "rejects managed peer bytes in the same physical root with %s", async scenario => {
      const f = await fixture();
      const managed = await f.request({ kind: "catalog", id: "private-repo" });
      const checkout = path.join(f.admission.cwd, managed.repository.relativePath);
      await mkdir(path.join(checkout, ".git"), { recursive: true });
      await writeFile(path.join(checkout, "private.txt"), "Private peer bytes");
      if (scenario !== "unpinned_publication") await db.update(executionWorkspaceRepositories)
        .set({ state: "ready", pinnedCommit: "b".repeat(40) }).where(eq(executionWorkspaceRepositories.id, managed.operationId));
      const [peer] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Same physical folder",
        cwd: f.admission.cwd, mode: "isolated_workspace", strategyType: "task_directory" }).returning();
      const issueId = randomUUID(), runId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Low-trust peer", assigneeAgentId: f.agentId,
        executionWorkspaceId: peer.id });
      const policy = { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy,
        trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, rootIssueId: issueId } } };
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running",
        responsibleUserId: f.userId, contextSnapshot: { issueId, executionPolicy: policy } });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      if (scenario !== "empty_inventory") await f.service.request({ companyId: f.companyId, issueId, actor: { ...f.actor, runId },
        request: { requestKey: randomUUID(), repository: { kind: "url", url: scenario === "same_repository" ? managed.repository.repoUrl : "https://github.com/public/other" } } });
      await expect(f.service.prepareForAdmission({ ...f.admission, issueId, runId, workspaceId: peer.id })).rejects.toThrow(/anonymous public URLs only/);
      expect(acquisition.materialize).not.toHaveBeenCalled();
      expect(acquisition.managedAuth).not.toHaveBeenCalled();
      expect(await readFile(path.join(checkout, "private.txt"), "utf8")).toBe("Private peer bytes");
    },
  );

  it("retains previous run trust without confusing a board request's reassigned agent", async () => {
    const f = await fixture();
    const [replacement] = await db.insert(agents).values({ companyId: f.companyId, name: "Replacement", adapterType: "process" }).returning();
    await db.update(issues).set({ assigneeAgentId: replacement.id }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", contextSnapshot: { taskId: f.issueId } }).where(eq(heartbeatRuns.id, f.runId));
    const request = () => f.service.request({ companyId: f.companyId, issueId: f.issueId,
      actor: { type: "board", source: "local_implicit", userId: "local-board" },
      request: { requestKey: randomUUID(), repository: { kind: "catalog", id: "private-repo" } } });
    await expect(request()).resolves.toMatchObject({ kind: "requires_next_admission" });
    await db.update(heartbeatRuns).set({ contextSnapshot: { taskId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(request()).rejects.toThrow(/anonymous public URLs only/);
  });

  it("rejects admission without the persisted task run before materialization", async () => {
    const f = await fixture();
    await f.request({ kind: "catalog", id: "private-repo" });
    await expect(f.service.prepareForAdmission({ ...f.admission, runId: randomUUID() })).rejects.toThrow(/run identity/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });
});
