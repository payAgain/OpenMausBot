import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-user-approval';

export const name = 'openmausbot-superagent-fixture';
export const inject = ['llm', 'tools', 'approval'];

function* text(value: string): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: value };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
  yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

function* call(name: string, args: object): Generator<StreamChunk> {
  const id = ToolCallId(`official-fixture-${randomUUID()}`);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } };
  yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 5, cacheReadTokens: 2 } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

const content = (message: GenerateOptions['messages'][number]) => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');

class OfficialFixture extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (process.env.PERSONBOT_OFFICIAL_FIXTURE_DEBUG === '1') process.stderr.write(`${JSON.stringify({ fixtureRequest: options.sessionId, messages: options.messages.filter(message => !['system-prompt', 'runtime-context', 'time-context'].includes(message.source?.kind ?? '')) })}\n`);
    if (!options.sessionId) {
      const prompt = content(options.messages.at(-1)!);
      yield* text(prompt.includes('CAPTURE step') ? '[]' : `fixture auxiliary: ${prompt}`);
      return;
    }
    const producer = options.messages.map((message, index) => {
      if (message.role !== 'user' || message.source?.kind !== 'dsh-superagent' || message.source.form !== 'relay') return undefined;
      try { return { index, value: JSON.parse(content(message)) as Record<string, unknown> }; } catch { return undefined; }
    }).filter(value => value !== undefined);
    const worker = String(options.sessionId).startsWith('worker-');
    const called = (index: number, name: string, matches: (args: Record<string, unknown>) => boolean) => options.messages.slice(index + 1).some(message =>
      message.role === 'assistant' && message.content.some(block => {
        if (block.type !== 'tool-call' || block.name !== name) return false;
        try { return matches(JSON.parse(block.arguments) as Record<string, unknown>); } catch { return false; }
      }));
    const actionable = worker ? producer.at(-1) : producer.findLast(entry => {
      const value = entry.value;
      if (value.kind === 'candidate') {
        if (String(value.text).startsWith('task ')) return !called(entry.index, 'orchestrator_route', args => (args.decisions as { trigger_id: string }[] | undefined)?.some(decision => decision.trigger_id === value.trigger_id) ?? false);
        return !called(entry.index, 'orchestrator_reply', args => args.trigger_id === value.trigger_id);
      }
      const ticket = value.ticket as { ticket_id?: string; attention?: { question?: string } } | undefined;
      if (value.kind === 'worker_report') return !called(entry.index, 'orchestrator_reply', args => args.ticket_id === ticket?.ticket_id && args.text === String(value.summary ?? 'Official task completed.'));
      if (value.kind === 'worker_attention') return !called(entry.index, 'orchestrator_reply', args => args.ticket_id === ticket?.ticket_id && args.human_action === ticket?.attention?.question);
      return false;
    });
    if (!actionable) { yield* text(''); return; }
    const at = actionable.index;
    const latest = options.messages[at];
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(latest ? content(latest) : '{}') as Record<string, unknown>; } catch {}
    const after = options.messages.slice(at + 1);
    const used = (name: string) => after.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call' && block.name === name));
    const results = after.filter(message => message.role === 'tool').map(content).join('\n');
    if (worker) {
      const request = value.text ?? (value.trigger as { text?: string } | undefined)?.text;
      if (typeof request !== 'string') { yield* text(''); return; }
      if (request === 'task background approval') {
        if (!used('orchestrator_report')) { yield* call('orchestrator_report', { state: 'blocked', summary: 'Background execution is waiting for approval.', human_action: 'A file operation needs your approval.' }); return; }
        if (!used('official_fixture_approval')) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new Error('Fixture background approval cancelled')); };
            const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, 750);
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener('abort', abort, { once: true });
          });
          yield* call('official_fixture_approval', {});
          return;
        }
        if (!called(at, 'orchestrator_report', args => args.state === 'ready')) { yield* call('orchestrator_report', { state: 'ready', summary: `Background approval result${results ? `\n${results}` : ''}` }); return; }
        yield* text(''); return;
      }
      if (request === 'task attention') {
        if (!used('orchestrator_report')) { yield* call('orchestrator_report', { state: 'blocked', summary: 'A destination is required before completing this task.', human_action: 'Which destination?' }); return; }
        yield* text(''); return;
      }
      if (request.startsWith('attention answer ')) {
        if (!used('orchestrator_report')) { yield* call('orchestrator_report', { state: 'ready', summary: `Official attention result: ${request.slice('attention answer '.length)}` }); return; }
        yield* text(''); return;
      }
      if (request.includes('hold')) {
        if (!options.signal) throw new Error('Fixture hold requires cancellation');
        await new Promise<void>((_resolve, reject) => {
          const aborted = () => reject(new Error('Fixture held request cancelled'));
          if (options.signal!.aborted) aborted();
          else options.signal!.addEventListener('abort', aborted, { once: true });
        });
      }
      if (request.includes('approval') && !used('official_fixture_approval')) { yield* call('official_fixture_approval', {}); return; }
      if (request.includes('question') && !used('ask_user_question')) { yield* call('ask_user_question', { questions: [{ id: 'format', question: 'Which format?', options: [{ label: 'Markdown' }, { label: 'Text' }] }] }); return; }
      if (request.includes('write ') && !used('write')) { yield* call('write', { file_path: request.slice(request.indexOf('write ') + 6).trim().split(/\s/)[0] || 'official-proof.txt', content: 'Official Super Agent worker executed a native DSH file tool.\n' }); return; }
      if (request.includes('memory ') && !used('memory_search')) { yield* call('memory_search', { query: request.slice(request.indexOf('memory ') + 7) }); return; }
      if (request.includes('propose ') && !used('memory_propose')) { yield* call('memory_propose', { text: request.slice(request.indexOf('propose ') + 8) }); return; }
      if (request.includes('remember ') && !used('memory_remember')) { yield* call('memory_remember', { text: request.slice(request.indexOf('remember ') + 9) }); return; }
      if (request.includes('forget ') && !used('memory_forget')) { yield* call('memory_forget', { query: request.slice(request.indexOf('forget ') + 7) }); return; }
      if (request.includes('history ') && !used('task_history_search')) { yield* call('task_history_search', { query: request.slice(request.indexOf('history ') + 8), limit: 10 }); return; }
      if (!used('orchestrator_report')) { yield* call('orchestrator_report', { state: 'ready', summary: `Official worker completed: ${request}${results ? `\n${results}` : ''}` }); return; }
      yield* text('');
      return;
    }
    if (value.kind === 'worker_attention') {
      const ticket = value.ticket as { ticket_id: string; attention: { question: string } };
      if (!used('orchestrator_reply')) { yield* call('orchestrator_reply', { purpose: 'attention', ticket_id: ticket.ticket_id, text: ticket.attention.question, human_action: ticket.attention.question }); return; }
      yield* text(''); return;
    }
    if (value.kind === 'worker_report') {
      if (!used('orchestrator_reply')) { yield* call('orchestrator_reply', { purpose: 'result', ticket_id: (value.ticket as { ticket_id: string }).ticket_id, text: String(value.summary ?? 'Official task completed.') }); return; }
      yield* text(''); return;
    }
    if (value.kind === 'candidate') {
      const request = String(value.text ?? '');
      if (!used('orchestrator_route')) {
        yield* call('orchestrator_route', { decisions: request.startsWith('task ') ? [{ kind: 'accept', trigger_id: value.trigger_id, title: request.slice(5), worktree_name: 'official-task', acknowledgement: '已接收，正在使用官方 Super Agent Worker 执行。' }] : [{ kind: 'ignore', trigger_id: value.trigger_id, reason: 'Ordinary personal conversation, no background ticket required' }] });
        return;
      }
      if (request.startsWith('task ')) { yield* text(''); return; }
      if (request.startsWith('remember ') && !used('memory_remember')) { yield* call('memory_remember', { text: request.slice(9) }); return; }
      if (request.startsWith('memory ') && !used('memory_search')) { yield* call('memory_search', { query: request.slice(7) }); return; }
      if (request.startsWith('forget ') && !used('memory_forget')) { yield* call('memory_forget', { query: request.slice(7) }); return; }
      if (request.startsWith('probe forget ') && !used('memory_forget')) { yield* call('memory_forget', { query: request.slice(13) }); return; }
      if (request.startsWith('probe main write ') && !used('bash')) {
        const file = request.slice(17);
        if (!/^[\w.-]+$/.test(file)) throw new Error('The fixture main write uses one local filename');
        yield* call('bash', { command: `printf 'native-main-write\\n' > '${file}'`, description: 'Write one isolated native main-session fixture file', timeoutMs: 1000 });
        return;
      }
      if (!used('orchestrator_reply')) { yield* call('orchestrator_reply', { purpose: 'answer', trigger_id: value.trigger_id, text: results.includes('memories') || request.startsWith('memory ') || request.startsWith('probe forget ') ? results : request.startsWith('echo ') ? request.slice(5) : request }); return; }
    }
    yield* text('');
  }
}

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['official-fixture'], new OfficialFixture());
  ctx.tools.register({
    name: 'official_fixture_approval', description: 'Write an isolated fixture marker after the native approval service allows it.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (_args, execution) => {
      if (!execution.agent) throw new Error('Fixture requires native agent');
      const outcome = await ctx.approval.request({ agent: execution.agent, toolName: 'official_fixture_approval', callId: execution.callId, signal: execution.signal });
      if (outcome !== 'allowed-once') return { written: false, outcome };
      await writeFile(join(execution.agent.session.header.cwd ?? '', 'official-approved.txt'), 'approved\n', { signal: execution.signal });
      return { written: true };
    },
  });
}
