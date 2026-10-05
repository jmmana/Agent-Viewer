import express from 'express';

const app = express();
const port = Number(process.env.PORT ?? 8787);
const events: unknown[] = [];
const clients = new Set<express.Response>();

app.use(express.json({ limit: '1mb' }));

app.use('/api/v1', (req, res, next) => {
  const expected = process.env.AGENT_VIEWER_API_TOKEN;
  if (!expected) return next();
  const auth = req.header('authorization');
  if (auth !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.AGENT_VIEWER_CORS_ORIGIN ?? '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, idempotency-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  next();
});

app.options('*', (_, res) => res.sendStatus(204));

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'agent-viewer-ingestion', schemaVersion: '1.0' });
});

app.get('/api/v1/snapshot', (_, res) => {
  res.json({ schemaVersion: '1.0', events });
});

app.get('/api/v1/events/stream', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');
  clients.add(res);

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

app.post('/api/v1/events', (req, res) => {
  const event = req.body;
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.id !== 'string' ||
    typeof event.type !== 'string' ||
    typeof event.timestamp !== 'number' ||
    typeof event.source !== 'string' ||
    typeof event.summary !== 'string' ||
    typeof event.payload !== 'object'
  ) {
    res.status(400).json({ error: 'invalid-event-envelope' });
    return;
  }

  if (events.some((item: any) => item?.id === event.id)) {
    res.status(200).json({ accepted: true, duplicate: true, id: event.id });
    return;
  }

  events.unshift(event);
  if (events.length > 10000) events.length = 10000;

  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(frame);

  res.status(202).json({ accepted: true, duplicate: false, id: event.id });
});

app.listen(port, () => {
  console.log(`Agent Viewer ingestion listening on http://localhost:${port}`);
});
