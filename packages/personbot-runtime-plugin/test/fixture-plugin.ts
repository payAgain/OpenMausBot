import { randomUUID } from 'node:crypto';
import { writeFile, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-user-approval';

export const name = 'personbot-fixture';
export const inject = ['llm', 'tools', 'approval'];

const WRITE_TOOL = 'personbot_fixture_write';

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) throw new Error('Fixture hold requires an abort signal');
  return new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new Error('Fixture hold aborted', { cause: signal.reason }));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function* textChunks(text: string): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

function* toolChunks(name: string, args: Record<string, unknown>): Generator<StreamChunk> {
  const id = ToolCallId(`fixture-${randomUUID()}`);
  const argumentsText = JSON.stringify(args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

function writeArguments(text: string): { path: string; text: string } {
  const argument = text.slice('approve'.length).trim();
  if (argument.startsWith('{')) {
    const value: unknown = JSON.parse(argument);
    if (!value || typeof value !== 'object'
      || typeof (value as Record<string, unknown>).path !== 'string'
      || typeof (value as Record<string, unknown>).text !== 'string') {
      throw new Error('Approve JSON requires path and text strings');
    }
    return value as { path: string; text: string };
  }
  return {
    path: argument || 'approved.txt',
    text: 'approved by personbot fixture\n',
  };
}

interface FixtureTask {
  taskId: string;
  executionId: string;
  goal: string;
  criteria: string[];
  context?: string;
}

function messageText(message: GenerateOptions['messages'][number]): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function fixtureTask(text: string): FixtureTask | undefined {
  const line = text.split('\n').find(entry => entry.startsWith('PERSONBOT_TASK='));
  if (!line) return undefined;
  const task: unknown = JSON.parse(line.slice('PERSONBOT_TASK='.length));
  if (!task || typeof task !== 'object'
    || typeof (task as FixtureTask).taskId !== 'string'
    || typeof (task as FixtureTask).executionId !== 'string'
    || typeof (task as FixtureTask).goal !== 'string') {
    throw new Error('Fixture task prompt requires taskId, executionId and goal');
  }
  return task as FixtureTask;
}

function reportCall(message: GenerateOptions['messages'][number]): boolean {
  return message.role === 'assistant'
    && message.content.some(block => block.type === 'tool-call' && block.name === 'personbot_task_report');
}

class FixtureAdapter extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const inputIndex = options.messages.findLastIndex(message =>
      message.role === 'user' && message.source?.kind === 'user');
    const input = options.messages[inputIndex];
    const contextSource = input?.source as { personbotContext?: { userBlock?: number } } | undefined;
    const text = (contextSource?.personbotContext?.userBlock === 1
      ? input?.content.findLast(block => block.type === 'text')
      : input?.content.find(block => block.type === 'text'))?.text ?? '';
    const result = options.messages.slice(inputIndex + 1).findLast(message => message.role === 'tool');
    const latest = options.messages.findLast(message => message.role === 'user');
    if ((latest?.source as { kind: string } | undefined)?.kind === 'personbot-supervisor') {
      yield* textChunks('Fixture task update received.');
      return;
    }
    const taskIndex = options.messages.findLastIndex(message =>
      message.role === 'user' && messageText(message).includes('PERSONBOT_TASK='));
    const task = taskIndex < 0 ? undefined : fixtureTask(messageText(options.messages[taskIndex]!));
    if (task) {
      if (options.messages.slice(taskIndex + 1).some(reportCall)) {
        yield* textChunks('Fixture task report recorded.');
        return;
      }
      if (task.goal === 'task-hold') {
        await waitForAbort(options.signal);
        return;
      }
      if (task.goal === 'task-no-report') {
        yield* textChunks('The worker ended without a structured business report.');
        return;
      }
      const after = options.messages.slice(taskIndex + 1);
      const used = (name: string) => after.some(message => message.role === 'assistant'
        && message.content.some(block => block.type === 'tool-call' && block.name === name));
      if (task.goal === 'task-child-join') {
        if (!used('subagent')) {
          yield* toolChunks('subagent', {
            description: 'Wait for an owned child before reporting',
            prompt: `wait-fixture ${resolve(process.env.HOME ?? '', `${task.taskId}-child-release`)}`,
          });
          return;
        }
        if (!after.some(message => message.role === 'user'
          && (message.source as { kind: string } | undefined)?.kind === 'subagent-settled')) {
          yield* textChunks('Waiting for the owned native child to finish.');
          return;
        }
      }
      if (task.goal === 'task-child-wait') {
        if (!used('subagent')) {
          yield* toolChunks('subagent', {
            description: 'Hold an owned task child model call',
            prompt: `hold-child-fixture ${task.taskId}`,
          });
          return;
        }
        const marker = resolve(process.env.HOME ?? '', `${task.taskId}-child-held`);
        for (;;) {
          options.signal?.throwIfAborted();
          try {
            await readFile(marker, 'utf8');
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          await delay(10, undefined, { signal: options.signal });
        }
      }
      if ((task.goal === 'task-question' || task.goal === 'task-supplement') && !used('ask_user_question')) {
        yield* toolChunks('ask_user_question', {
          questions: [{
            id: 'format',
            question: 'Which task format?',
            options: [{ label: 'Markdown' }, { label: 'Text' }],
          }],
        });
        return;
      }
      if ((task.goal === 'task-approved' || task.goal === 'task-artifact') && !used(WRITE_TOOL)) {
        yield* toolChunks(WRITE_TOOL, {
          path: task.goal === 'task-artifact' ? 'fixture-output.md' : `${task.taskId}-approved.txt`,
          text: 'approved by personbot task fixture\n',
        });
        return;
      }
      if (task.goal === 'task-artifact' && !used('personbot_artifact_publish')) {
        yield* toolChunks('personbot_artifact_publish', { path: 'fixture-output.md' });
        return;
      }
      if (task.goal.startsWith('task-background-') && !used('bash')) {
        const marker = `${task.taskId}-background.pid`;
        const program = `require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        yield* toolChunks('bash', {
          description: 'Start owned task fixture background process',
          command: `${quote(process.execPath)} -e ${quote(program)}`,
          run_in_background: true,
        });
        return;
      }
      if (task.goal === 'task-background-hold') {
        await waitForAbort(options.signal);
        return;
      }
      const waited = options.messages.slice(0, taskIndex).some(reportCall);
      const waiting = ((task.goal === 'task-wait' || task.goal === 'task-timer') && !waited)
        || task.goal === 'task-background-wait' || task.goal === 'task-child-wait';
      const writeDenied = task.goal === 'task-approved'
        && after.some(message => message.role === 'tool' && messageText(message).includes('"written":false'));
      const evidence = task.goal === 'task-no-evidence' || writeDenied ? []
        : task.goal === 'task-approved' ? [`fixture:approved:${task.taskId}-approved.txt`] : ['fixture:verified'];
      const published = after.filter(message => message.role === 'tool').flatMap(message => {
        try {
          const value = JSON.parse(messageText(message)) as { artifact?: { id?: string } };
          return value.artifact?.id ? [value.artifact.id] : [];
        } catch { return []; }
      });
      const supplements = after.filter(message => message.role === 'user' && (
        messageText(message).includes('Additional authorized requirements') || messageText(message).includes('External event context follows as JSON')
      ))
        .map(messageText).join('\n');
      yield* toolChunks('personbot_task_report', {
        executionId: task.executionId,
        outcome: task.goal === 'task-fail' ? 'failed' : writeDenied ? 'blocked' : waiting ? 'waiting_event' : 'review',
        summary: writeDenied ? 'The requested task write was denied.'
          : waiting ? 'Waiting for explicit task input.' : `Fixture completed ${task.goal}.${supplements ? `\n${supplements}` : ''}`,
        evidence,
        ...(published.length ? { artifactIds: published } : {}),
        ...(task.goal === 'task-timer' && waiting ? { wakeAt: new Date(Date.now() + 1_500).toISOString() } : {}),
      });
      return;
    }
    if (result) {
      yield* textChunks(result.content.filter(block => block.type === 'text').map(block => block.text).join(''));
      return;
    }
    if (text === 'context') {
      yield* textChunks(JSON.stringify({ context: input?.content.filter(block => block.type === 'text').slice(0, -1).map(block => block.text).join('\n') ?? '' }));
      return;
    }
    if (text.startsWith('memory-propose ')) {
      yield* toolChunks('personbot_memory_propose', JSON.parse(text.slice('memory-propose '.length)) as Record<string, unknown>);
      return;
    }
    if (text.startsWith('artifact ')) {
      yield* toolChunks('personbot_artifact_publish', JSON.parse(text.slice('artifact '.length)) as Record<string, unknown>);
      return;
    }
    if (text.startsWith('task ')) {
      yield* toolChunks('personbot_task_create', {
        goal: text.slice(5).trim(),
        criteria: ['Fixture evidence is present'],
        context: 'A deterministic isolated task fixture.',
      });
      return;
    }
    if (text === 'hold') {
      await waitForAbort(options.signal);
      return;
    }
    if (text.startsWith('hold-child-fixture ')) {
      const taskId = text.slice('hold-child-fixture '.length);
      if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error('Fixture child requires a task identity');
      await writeFile(resolve(process.env.HOME ?? '', `${taskId}-child-held`), 'holding\n');
      await waitForAbort(options.signal);
      return;
    }
    if (text.startsWith('wait-fixture ')) {
      const home = await realpath(process.env.HOME ?? '');
      const requested = resolve(text.slice('wait-fixture '.length));
      const marker = resolve(await realpath(dirname(requested)), basename(requested));
      if (!inside(home, marker)) throw new Error('Fixture latch must stay inside its isolated home');
      for (;;) {
        options.signal?.throwIfAborted();
        try {
          const path = await realpath(marker);
          if (!inside(home, path)) throw new Error('Fixture latch must not follow an external symlink');
          if ((await readFile(path, 'utf8')).trim() === 'release') break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await delay(10, undefined, { signal: options.signal });
      }
      yield* textChunks('Fixture latch released.');
      return;
    }
    if (text === 'child-approve' || text === 'child-hold' || text === 'child-question') {
      yield* toolChunks('subagent', {
        description: text === 'child-approve' ? 'Request child write approval' : 'Hold child model call',
        prompt: text === 'child-approve' ? 'approve child-approved.txt' : text === 'child-question' ? 'question' : 'hold',
      });
      return;
    }
    if (text === 'background') {
      const program = 'require("node:fs").writeFileSync("background.pid",String(process.pid));setInterval(()=>{},1000)';
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      yield* toolChunks('bash', {
        description: 'Start owned fixture background process',
        command: `${quote(process.execPath)} -e ${quote(program)}`,
        run_in_background: true,
      });
      return;
    }
    if (text === 'approve' || text.startsWith('approve ')) {
      yield* toolChunks(WRITE_TOOL, writeArguments(text));
      return;
    }
    if (text === 'question') {
      yield* toolChunks('ask_user_question', {
        questions: [{
          id: 'format',
          question: 'Which format?',
          options: [{ label: 'Markdown' }, { label: 'Text' }],
        }],
      });
      return;
    }
    yield* textChunks(text.startsWith('echo ') ? text.slice(5) : text);
  }
}

function inside(directory: string, path: string): boolean {
  const entry = relative(directory, path);
  return entry !== '..' && !entry.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(entry);
}

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['personbot-fixture'], new FixtureAdapter());
  ctx.tools.register({
    name: WRITE_TOOL,
    description: 'Write one fixture file inside the session workspace after explicit approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string' }, text: { type: 'string' } },
      required: ['path', 'text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' }, written: { type: 'boolean' } },
        required: ['path', 'written'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!args || typeof args !== 'object'
        || typeof (args as Record<string, unknown>).path !== 'string'
        || typeof (args as Record<string, unknown>).text !== 'string') {
        throw new Error('Fixture write requires path and text strings');
      }
      if (!exec.agent?.session.header.cwd) throw new Error('Fixture write requires an explicit session cwd');
      const { path: requested, text } = args as { path: string; text: string };
      const directory = await realpath(exec.agent.session.header.cwd);
      const path = resolve(directory, requested);
      const parent = await realpath(dirname(path));
      if (!inside(directory, path) || !inside(directory, parent)) {
        throw new Error('Fixture file must stay inside the session workspace');
      }
      const outcome = await ctx.approval.request({
        agent: exec.agent,
        toolName: WRITE_TOOL,
        callId: exec.callId,
        signal: exec.signal,
      });
      exec.signal.throwIfAborted();
      if (outcome !== 'allowed-once') return { path, written: false };
      await writeFile(path, text, { flag: 'wx', signal: exec.signal });
      return { path, written: true };
    },
  });
}
