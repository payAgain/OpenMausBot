import type {
  AssistantStreamProjection,
  MessageRow,
  NativeSessionEvent,
  NoticeRow,
  ToolRow,
  TranscriptBlock,
  TranscriptRow,
} from './types.ts';

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nativeBlocks(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function displayBlocks(value: unknown): TranscriptBlock[] {
  const result: TranscriptBlock[] = [];
  for (const valueBlock of nativeBlocks(value)) {
    const block = object(valueBlock);
    switch (block.type) {
      case 'text':
      case 'reasoning':
        if (typeof block.text === 'string') result.push({ type: block.type, text: block.text });
        break;
      case 'image':
      case 'file':
        result.push({
          type: 'attachment',
          kind: block.type,
          attachment: block.attachment,
          ...(block.offloaded === true ? { offloaded: true } : {}),
        });
        break;
      case 'tool-call':
        break;
      default:
        if (typeof block.type === 'string') {
          result.push({ type: 'unsupported', nativeType: block.type, data: valueBlock });
        }
    }
  }
  return result;
}

function text(blocks: readonly TranscriptBlock[], type: 'text' | 'reasoning'): string {
  return blocks.flatMap(block => block.type === type ? [block.text] : []).join('');
}

function toolId(callId: string, turn?: number, step?: number): string {
  return `tool:${turn ?? '?'}:${step ?? '?'}:${callId}`;
}

function toolCall(
  seq: number,
  time: number,
  data: Record<string, unknown>,
  status: ToolRow['status'],
): ToolRow | undefined {
  const callId = string(data.callId, string(data.id));
  if (!callId) return undefined;
  const turn = number(data.turn);
  const step = number(data.step);
  return {
    kind: 'tool',
    id: toolId(callId, turn, step),
    seq,
    time,
    turn,
    step,
    callId,
    name: string(data.name, 'Unknown tool'),
    arguments: string(data.arguments),
    status,
  };
}

function updateTool(rows: TranscriptRow[], tool: ToolRow): void {
  const index = rows.findIndex(row => row.id === tool.id);
  if (index === -1) rows.push(tool);
  else {
    const previous = rows[index] as ToolRow;
    rows[index] = {
      ...previous,
      ...tool,
      seq: previous.seq,
      time: previous.time,
      ...(previous.result ? { status: previous.status } : {}),
    };
  }
}

function messageRow(
  event: NativeSessionEvent,
  message: Record<string, unknown>,
  role: MessageRow['role'],
  turn?: number,
  step?: number,
  interrupted = false,
): MessageRow | undefined {
  const blocks = displayBlocks(message.content);
  if (blocks.length === 0) return undefined;
  const messageId = string(message.id, `native:${event.seq}`);
  return {
    kind: 'message',
    id: `message:${event.seq}:${messageId}`,
    seq: event.seq,
    time: event.time,
    role,
    messageId,
    blocks,
    text: text(blocks, 'text'),
    reasoning: text(blocks, 'reasoning'),
    status: interrupted ? 'interrupted' : 'complete',
    turn,
    step,
  };
}

function turnNotice(event: NativeSessionEvent): NoticeRow | undefined {
  const data = object(event.data);
  const reason = object(data.reason);
  const kind = string(reason.kind);
  const turn = number(data.turn);
  let message: string;
  let level: NoticeRow['level'] = 'warning';
  switch (kind) {
    case 'aborted': message = 'Turn stopped by cancellation.'; break;
    case 'interrupted': message = 'Turn interrupted before completion.'; break;
    case 'blocked': message = 'Turn is blocked.'; break;
    case 'max-tokens': message = 'Turn reached the output token limit.'; break;
    case 'forked': message = 'Inherited turn ended at the session fork.'; level = 'info'; break;
    case 'error': {
      const error = object(reason.error);
      message = string(error.message, 'Turn failed.');
      level = 'error';
      break;
    }
    default: return undefined;
  }
  return {
    kind: 'notice',
    id: `notice:${event.seq}`,
    seq: event.seq,
    time: event.time,
    turn,
    level,
    code: kind,
    message,
  };
}

/** Project a human transcript from native log history; this does not reconstruct the model request surface. */
export function projectSessionEvents(events: readonly NativeSessionEvent[]): readonly TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const seen = new Set<number>();
  let turn: number | undefined;
  let step: number | undefined;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (number(event.seq) === undefined || seen.has(event.seq)) continue;
    seen.add(event.seq);
    const data = object(event.data);
    switch (event.type) {
      case 'turn/start':
        turn = number(data.turn);
        step = undefined;
        break;
      case 'step/start':
        turn = number(data.turn);
        step = number(data.step);
        break;
      case 'user/message': {
        const source = object(data.source);
        if (source.kind === 'personbot-supervisor') {
          rows.push({
            id: `task-notice:${string(data.id, String(event.seq))}`,
            kind: 'notice', code: 'personbot-task-result', level: 'info',
            seq: event.seq, time: event.time,
            message: text(displayBlocks(data.content), 'text'),
          });
          break;
        }
        if (source.kind !== undefined && source.kind !== 'user') break;
        const context = object(source.personbotContext);
        const userBlock = number(context.userBlock);
        const display = userBlock === 1 && nativeBlocks(data.content).length === 2
          ? { ...data, content: nativeBlocks(data.content).slice(1) }
          : data;
        const row = messageRow(event, display, 'user', turn, step);
        if (row) rows.push(row);
        break;
      }
      case 'assistant/message': {
        const message = object(data.message);
        const messageTurn = number(data.turn);
        const messageStep = number(data.step);
        const row = messageRow(event, message, 'assistant', messageTurn, messageStep, data.interrupted === true);
        if (row) rows.push(row);
        for (const blockValue of nativeBlocks(message.content)) {
          const block = object(blockValue);
          if (block.type !== 'tool-call') continue;
          const tool = toolCall(event.seq, event.time, { ...block, turn: messageTurn, step: messageStep }, 'requested');
          if (tool) updateTool(rows, tool);
        }
        break;
      }
      case 'tool/call': {
        const tool = toolCall(event.seq, event.time, data, 'running');
        if (tool) updateTool(rows, tool);
        break;
      }
      case 'tool/result': {
        const message = object(data.message);
        const source = object(message.source);
        const callId = string(message.toolCallId, string(source.callId));
        const resultTurn = number(data.turn);
        const resultStep = number(data.step);
        const id = toolId(callId, resultTurn, resultStep);
        if (!callId) break;
        const previous = rows.find(row => row.id === id) as ToolRow | undefined;
        const result = displayBlocks(message.content);
        const failure = object(data.error);
        const tool: ToolRow = {
          ...(previous ?? {
            kind: 'tool',
            id,
            seq: event.seq,
            time: event.time,
            turn: resultTurn,
            step: resultStep,
            callId,
            name: 'Unknown tool',
            arguments: '',
          }),
          status: message.isError === true ? 'failed' : 'succeeded',
          result,
          resultText: text(result, 'text'),
          ...(message.isError === true && data.error !== undefined ? {
            error: {
              name: typeof failure.name === 'string' ? failure.name : undefined,
              code: typeof failure.code === 'string' ? failure.code : undefined,
              reason: typeof failure.reason === 'string' ? failure.reason : undefined,
            },
          } : {}),
          ...(data.meta !== undefined ? { meta: data.meta } : {}),
        };
        const index = rows.findIndex(row => row.id === id);
        if (index === -1) rows.push(tool);
        else rows[index] = tool;
        break;
      }
      case 'turn/end': {
        const endedTurn = number(data.turn);
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          if (row.kind === 'tool' && row.turn === endedTurn && (row.status === 'requested' || row.status === 'running')) {
            rows[index] = { ...row, status: 'interrupted' };
          }
        }
        const notice = turnNotice(event);
        if (notice) rows.push(notice);
        if (turn === endedTurn) {
          turn = undefined;
          step = undefined;
        }
        break;
      }
    }
  }
  return rows;
}

/** Reassemble provisional blocks by native block index; block-end replaces the delivered prefix. */
export function projectStream(stream: AssistantStreamProjection, seq: number): readonly TranscriptRow[] {
  const blocks = new Map<number, Record<string, unknown>>();
  for (const frame of stream.chunks) {
    const chunk = object(frame.chunk);
    const index = number(chunk.index);
    if (index === undefined) continue;
    const previous = blocks.get(index) ?? {};
    switch (chunk.type) {
      case 'block-start':
        if (!blocks.has(index)) blocks.set(index, { type: chunk.blockType });
        break;
      case 'text-delta':
      case 'reasoning-delta':
        blocks.set(index, {
          type: chunk.type === 'text-delta' ? 'text' : 'reasoning',
          text: string(previous.text) + string(chunk.text),
        });
        break;
      case 'tool-call-delta':
        blocks.set(index, {
          type: 'tool-call',
          id: string(chunk.id, string(previous.id)),
          name: string(chunk.name, string(previous.name)),
          arguments: string(previous.arguments) + string(chunk.argumentsDelta),
        });
        break;
      case 'block-end':
        blocks.set(index, object(chunk.block));
        break;
    }
  }
  const content = [...blocks].sort(([left], [right]) => left - right).map(([, block]) => block);
  const event: NativeSessionEvent = { seq, time: stream.chunks[0]?.time ?? 0, type: 'assistant/message', data: {} };
  const row = messageRow(event, { id: stream.attemptId, content }, 'assistant', stream.turn, stream.step);
  const rows: TranscriptRow[] = row
    ? [{ ...row, id: `stream:${stream.attemptId}`, status: stream.status }]
    : [];
  for (const block of content) {
    if (block.type !== 'tool-call') continue;
    const tool = toolCall(event.seq, event.time, { ...block, turn: stream.turn, step: stream.step }, 'requested');
    if (tool) rows.push(tool);
  }
  return rows;
}
