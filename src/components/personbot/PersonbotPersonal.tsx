import { useState, type FormEvent } from "react";
import type { PersonbotClient } from "@/lib/personbot-client";
import type { MemoryRecord, PersonalSnapshot, ProjectRecord, RoleRecord } from "../../../packages/personbot-protocol/src/index.ts";

const BUTTON = "inline-flex min-h-11 items-center justify-center rounded-lg border border-hairline px-3 text-[14px] text-ink enabled:hover:bg-raised disabled:cursor-not-allowed disabled:text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const INPUT = "mt-2 min-h-11 w-full min-w-0 rounded-lg border border-hairline bg-app px-3 py-2 text-[14px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const EMPTY: PersonalSnapshot = { projects: [], roles: [], memories: [] };
type PersonalClient = Pick<PersonbotClient, "saveProject" | "saveRole" | "saveMemory" | "controlMemory">;

function ProjectForm({ project, client, disabled, done }: { project?: ProjectRecord; client: PersonalClient; disabled: boolean; done(): void }) {
  const [name, setName] = useState(project?.name ?? "");
  const [path, setPath] = useState(project?.path ?? "");
  const [kind, setKind] = useState<ProjectRecord["kind"]>(project?.kind ?? "directory");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (await client.saveProject({ id: project?.id, revision: project?.revision, name: name.trim(), path: path.trim(), kind })) done();
  };
  return <form aria-label="项目设置" className="space-y-3" onSubmit={(event) => void save(event)}>
    <label className="block">项目名称<input aria-label="项目名称" className={INPUT} value={name} onChange={(event) => setName(event.target.value)} required disabled={disabled} /></label>
    <label className="block">项目目录<input aria-label="项目目录" className={INPUT} value={path} onChange={(event) => setPath(event.target.value)} required disabled={disabled} placeholder="绝对目录路径" /></label>
    <label className="block">项目类型<select aria-label="项目类型" className={INPUT} value={kind} onChange={(event) => setKind(event.target.value as ProjectRecord["kind"])} disabled={disabled}><option value="directory">普通目录</option><option value="git">Git 仓库</option></select></label>
    <p className="text-ink-secondary">新会话使用项目目录。独立任务使用自己的输出目录；Git 项目为任务建立独立工作树。</p>
    <div className="flex flex-wrap gap-2"><button className={BUTTON} type="submit" disabled={disabled || !name.trim() || !path.trim()}>保存项目</button><button className={BUTTON} type="button" disabled={disabled} onClick={done}>取消编辑</button></div>
  </form>;
}

function RoleForm({ role, client, disabled, done }: { role?: RoleRecord; client: PersonalClient; disabled: boolean; done(): void }) {
  const [name, setName] = useState(role?.name ?? "");
  const [instructions, setInstructions] = useState(role?.instructions ?? "");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (await client.saveRole({ id: role?.id, revision: role?.revision, name: name.trim(), instructions: instructions.trim() })) done();
  };
  return <form aria-label="角色设置" className="space-y-3" onSubmit={(event) => void save(event)}>
    <label className="block">角色名称<input aria-label="角色名称" className={INPUT} value={name} onChange={(event) => setName(event.target.value)} required disabled={disabled} /></label>
    <label className="block">角色说明<textarea aria-label="角色说明" className={INPUT} rows={5} value={instructions} onChange={(event) => setInstructions(event.target.value)} required disabled={disabled} /></label>
    <p className="text-ink-secondary">说明只应用于之后建立的会话。现有会话保留创建时的角色版本。</p>
    <div className="flex flex-wrap gap-2"><button className={BUTTON} type="submit" disabled={disabled || !name.trim() || !instructions.trim()}>保存角色</button><button className={BUTTON} type="button" disabled={disabled} onClick={done}>取消编辑</button></div>
  </form>;
}

function MemoryForm({ memory, projects, client, projectId, disabled, done }: { memory?: MemoryRecord; projects: ProjectRecord[]; client: PersonalClient; projectId?: string; disabled: boolean; done(): void }) {
  const [scope, setScope] = useState<MemoryRecord["scope"]>(memory?.scope ?? "personal");
  const [project, setProject] = useState(memory?.projectId ?? projectId ?? projects[0]?.id ?? "");
  const [key, setKey] = useState(memory?.key ?? "");
  const [value, setValue] = useState(memory?.value ?? "");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (await client.saveMemory({ id: memory?.id, revision: memory?.revision, scope, ...(scope === "project" ? { projectId: project } : {}), key: key.trim(), value: value.trim() })) done();
  };
  return <form aria-label="记忆设置" className="space-y-3" onSubmit={(event) => void save(event)}>
    <label className="block">记忆范围<select aria-label="记忆范围" className={INPUT} value={scope} onChange={(event) => setScope(event.target.value as MemoryRecord["scope"])} disabled={disabled || !!memory}><option value="personal">个人</option><option value="project">项目</option></select></label>
    {scope === "project" && <label className="block">记忆所属项目<select aria-label="记忆所属项目" className={INPUT} value={project} onChange={(event) => setProject(event.target.value)} disabled={disabled || !!memory}>{projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>}
    <label className="block">记忆名称<input aria-label="记忆名称" className={INPUT} value={key} onChange={(event) => setKey(event.target.value)} required disabled={disabled || !!memory} /></label>
    <label className="block">记忆内容<textarea aria-label="记忆内容" className={INPUT} rows={3} value={value} onChange={(event) => setValue(event.target.value)} required disabled={disabled} /></label>
    <div className="flex flex-wrap gap-2"><button className={BUTTON} type="submit" disabled={disabled || !key.trim() || !value.trim() || (scope === "project" && !project)}>保存记忆</button><button className={BUTTON} type="button" disabled={disabled} onClick={done}>取消编辑</button></div>
  </form>;
}

export function PersonbotPersonal({ snapshot = EMPTY, client, projectId, disabled, expanded = false }: { snapshot?: PersonalSnapshot; client: PersonalClient; projectId?: string; disabled: boolean; expanded?: boolean }) {
  const [tab, setTab] = useState<"projects" | "roles" | "memories">("projects");
  const [editing, setEditing] = useState<string | null>(null);
  const memories = snapshot.memories.filter((memory) => memory.status === "active" || memory.status === "proposed");
  const switchTab = (next: typeof tab) => { setTab(next); setEditing(null); };
  return <details className="personbot-personal mb-4 rounded-lg border border-hairline" data-personbot-personal="" open={expanded || undefined}>
    <summary className="min-h-11 cursor-pointer px-3 py-3 text-[14px] font-medium">个人设置 <span className="ms-2 text-[12px] font-normal text-ink-secondary">项目、角色与记忆</span></summary>
    <div className="space-y-4 border-t border-hairline p-3 text-[13px]">
      <div className="flex flex-wrap gap-2" aria-label="个人设置分类">
        {([["projects", "项目"], ["roles", "角色"], ["memories", "记忆"]] as const).map(([value, label]) => <button key={value} type="button" className={BUTTON} aria-pressed={tab === value} onClick={() => switchTab(value)}>{label}</button>)}
      </div>
      {tab === "projects" && <>
        <div className="flex items-center justify-between gap-2"><h2 className="font-medium">项目</h2><button type="button" className={BUTTON} disabled={disabled} onClick={() => setEditing("new")}>添加项目</button></div>
        {editing !== null ? <ProjectForm key={editing} project={snapshot.projects.find((project) => project.id === editing)} client={client} disabled={disabled} done={() => setEditing(null)} /> : snapshot.projects.length ? <ul className="divide-y divide-hairline">{snapshot.projects.map((project) => <li key={project.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3"><div className="min-w-0 flex-1"><p>{project.name} <span className="text-[12px] text-ink-secondary">{project.kind === "git" ? "Git" : "目录"}</span></p><p className="mt-1 break-all text-ink-secondary">{project.path}</p></div><button type="button" className={BUTTON} aria-label={`编辑项目：${project.name}`} disabled={disabled} onClick={() => setEditing(project.id)}>编辑</button></li>)}</ul> : <p className="text-ink-secondary">添加工作目录，之后建立会话时选择它。</p>}
      </>}
      {tab === "roles" && <>
        <div className="flex items-center justify-between gap-2"><h2 className="font-medium">角色</h2><button type="button" className={BUTTON} disabled={disabled} onClick={() => setEditing("new")}>添加角色</button></div>
        {editing !== null ? <RoleForm key={editing} role={snapshot.roles.find((role) => role.id === editing)} client={client} disabled={disabled} done={() => setEditing(null)} /> : snapshot.roles.length ? <ul className="divide-y divide-hairline">{snapshot.roles.map((role) => <li key={role.id} className="py-3"><div className="flex items-center justify-between gap-2"><p>{role.name} <span className="text-[12px] text-ink-secondary">版本 {role.revision}</span></p><button type="button" className={BUTTON} aria-label={`编辑角色：${role.name}`} disabled={disabled} onClick={() => setEditing(role.id)}>编辑</button></div><p className="mt-2 whitespace-pre-wrap break-words text-ink-secondary">{role.instructions || "使用默认助手说明。"}</p></li>)}</ul> : <p className="text-ink-secondary">保存常用角色的工作方式。</p>}
      </>}
      {tab === "memories" && <>
        <div className="flex items-center justify-between gap-2"><h2 className="font-medium">记忆</h2><button type="button" className={BUTTON} disabled={disabled} onClick={() => setEditing("new")}>添加记忆</button></div>
        {editing !== null ? <MemoryForm key={editing} memory={memories.find((memory) => memory.id === editing)} projects={snapshot.projects} projectId={projectId} client={client} disabled={disabled} done={() => setEditing(null)} /> : <>
          <p className="text-ink-secondary">已保存的记忆会用于后续输入。Agent 建议的记忆需要你确认后才会生效。</p>
          {memories.length ? <ul className="divide-y divide-hairline">{memories.map((memory) => <li key={memory.id} data-personbot-memory={memory.id} className="py-3"><p className="font-medium">{memory.key} <span className="ms-2 text-[12px] font-normal text-ink-secondary">{memory.scope === "personal" ? "个人" : snapshot.projects.find((project) => project.id === memory.projectId)?.name ?? "项目"} · {memory.status === "proposed" ? "等待确认" : "已生效"}</span></p><p className="mt-2 whitespace-pre-wrap break-words">{memory.value}</p><div className="mt-3 flex flex-wrap gap-2">{memory.status === "proposed" ? <button type="button" className={BUTTON} disabled={disabled} onClick={() => void client.controlMemory(memory, "confirm")}>确认记忆</button> : <button type="button" className={BUTTON} disabled={disabled} onClick={() => setEditing(memory.id)}>纠正记忆</button>}<button type="button" className={BUTTON} disabled={disabled} onClick={() => void client.controlMemory(memory, "forget")}>{memory.status === "proposed" ? "忽略建议" : "忘记记忆"}</button></div></li>)}</ul> : <p className="py-2 text-ink-secondary">还没有保存的记忆。</p>}
        </>}
      </>}
    </div>
  </details>;
}
