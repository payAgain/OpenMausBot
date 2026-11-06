import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'normal';
if (mode === 'ignore-signals') process.on('SIGTERM', () => {});
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
  switch (request.method) {
    case 'echo':
      reply(request.params);
      break;
    case 'fragmented': {
      const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '你好' })}\r\n`);
      const split = bytes.indexOf(Buffer.from('你')) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setImmediate(() => process.stdout.write(bytes.subarray(split)));
      break;
    }
    case 'notify':
      send({ jsonrpc: '2.0', method: 'personbot.v1.event', params: { type: 'fixture.progress' } });
      reply({});
      break;
    case 'later':
      setTimeout(() => reply(request.params.value), request.params.delay);
      break;
    case 'error':
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Rejected', data: { reason: 'fixture' } } });
      break;
    case 'bad-json':
      process.stdout.write('unexpected log\n');
      break;
    case 'bad-response':
      send({ jsonrpc: '2.0', id: request.id, result: 1, error: { code: 1, message: 'bad' } });
      break;
    case 'oversize':
      process.stdout.write('x'.repeat(request.params.size));
      break;
    case 'stderr':
      process.stderr.write(request.params.text, () => reply({}));
      break;
    case 'exit':
      process.exit(7);
      break;
    case 'personbot.v1.shutdown':
      if (mode !== 'ignore-signals') {
        reply({});
        input.close();
        process.stdin.destroy();
      }
      break;
    default:
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } });
  }
});
