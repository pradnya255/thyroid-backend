import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

app.use(cors({ origin: 'http://localhost:4200', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// ── Connected WebSocket clients ──────────────────────────────────────────────
const clients = new Map();

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(clientId, ws);
  console.log(`[WS] Client connected: ${clientId}`);

  ws.send(JSON.stringify({ type: 'connected', clientId, message: 'Connected to Thyroid Diet Server' }));

  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[WS] Client disconnected: ${clientId}`);
  });

  ws.on('error', (err) => console.error('[WS] Error:', err));
});

function broadcast(data) {
  const payload = JSON.stringify(data);
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(payload);
  });
}

// ── MCP Client Setup ─────────────────────────────────────────────────────────
let mcpClient = null;

async function initMCPClient() {
  try {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(__dirname, '../mcp-server/mcp-server.js')]
    });

    mcpClient = new Client({ name: 'thyroid-backend-client', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
    console.log('[MCP] Connected to MCP server');
  } catch (err) {
    console.error('[MCP] Failed to connect:', err.message);
    mcpClient = null;
  }
}

async function callMCPTool(toolName, toolArgs) {
  if (!mcpClient) throw new Error('MCP client not connected');
  const result = await mcpClient.callTool({ name: toolName, arguments: toolArgs });
  return JSON.parse(result.content[0].text);
}

// ── Fallback local logic (if MCP is unavailable) ─────────────────────────────
function localAnalyze(tsh, t3, t4, weight, height, age, gender) {
  let status, severity;
  if (tsh > 4.5) { status = 'hypothyroid'; severity = tsh > 10 ? 'Severe' : tsh > 7 ? 'Moderate' : 'Mild'; }
  else if (tsh < 0.5) { status = 'hyperthyroid'; severity = tsh < 0.1 ? 'Severe' : 'Mild'; }
  else { status = 'normal'; severity = 'None'; }

  let bmi = null, bmiCategory = null;
  if (weight && height) {
    const hm = height / 100;
    bmi = parseFloat((weight / (hm * hm)).toFixed(1));
    if (bmi < 18.5) bmiCategory = 'Underweight';
    else if (bmi < 25) bmiCategory = 'Normal Weight';
    else if (bmi < 30) bmiCategory = 'Overweight';
    else bmiCategory = 'Obese';
  }
  return { status, severity, bmi, bmiCategory, tsh, t3, t4, weight, height, age, gender };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mcp: mcpClient ? 'connected' : 'fallback', timestamp: new Date().toISOString() });
});

// Main analysis endpoint
app.post('/api/thyroid/analyze', async (req, res) => {
  const { tsh, t3, t4, weight, height, age, gender } = req.body;

  if (tsh === undefined || tsh === null) {
    return res.status(400).json({ error: 'TSH value is required' });
  }

  broadcast({ type: 'processing', message: 'Analyzing thyroid levels via MCP server...' });

  try {
    let analysis, diet;

    // if (mcpClient) {
    if (false && mcpClient) {
      broadcast({ type: 'progress', step: 1, message: 'Calling MCP analyze_thyroid tool...' });
      analysis = await callMCPTool('analyze_thyroid', { tsh, t3, t4, weight, height, age, gender });

      broadcast({ type: 'progress', step: 2, message: 'Fetching personalized diet recommendations...' });
      diet = await callMCPTool('get_diet_recommendations', { thyroid_status: analysis.status });
    } else {
      analysis = localAnalyze(tsh, t3, t4, weight, height, age, gender);
      diet = { status: analysis.status, recommended: [], avoid: [], tips: [] };
    }

    const response = { analysis, diet, generatedAt: new Date().toISOString() };

    broadcast({ type: 'result', data: response, message: 'Analysis complete!' });
    res.json(response);
  } catch (err) {
    console.error('[API] Error:', err.message);
    broadcast({ type: 'error', message: err.message });
    res.status(500).json({ error: 'Analysis failed', details: err.message });
  }
});

// Diet recommendations only
app.get('/api/thyroid/diet/:status', async (req, res) => {
  const { status } = req.params;
  if (!['hypothyroid', 'hyperthyroid', 'normal'].includes(status)) {
    return res.status(400).json({ error: 'Invalid thyroid status' });
  }
  try {
    const diet = mcpClient
      ? await callMCPTool('get_diet_recommendations', { thyroid_status: status })
      : { status, recommended: [], avoid: [], tips: [] };
    res.json(diet);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, async () => {
  console.log(`\n🚀 Backend running at http://localhost:${PORT}`);
  console.log(`🔌 WebSocket available at ws://localhost:${PORT}/ws`);
  await initMCPClient();
});

process.on('SIGINT', async () => {
  if (mcpClient) await mcpClient.close();
  process.exit(0);
});
