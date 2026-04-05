const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');

const DICT_PATH = path.join(__dirname, 'dictionary.json');
const PORT = process.env.PORT || 3001;

function loadDictionary() {
  return JSON.parse(fs.readFileSync(DICT_PATH, 'utf-8'));
}

function createServer() {
  const server = new McpServer({
    name: '小説執筆用辞書',
    version: '1.0.0',
  });

  // Tool 1: キーワード検索
  server.tool(
    'dictionary_search',
    '辞書からキーワードで表現を検索する。部分一致で検索し、マッチした表現とカテゴリを返す。',
    { query: z.string().describe('検索キーワード（例：「眉」「緊張」「視線」）') },
    async ({ query }) => {
      const dict = loadDictionary();
      const q = query.toLowerCase();
      const results = [];
      dict.sections.forEach(section => {
        section.subsections.forEach(sub => {
          sub.items.forEach(item => {
            if (item.toLowerCase().includes(q)) {
              results.push({ text: item, category: `${section.title} > ${sub.fullTitle}` });
            }
          });
        });
      });
      if (results.length === 0) {
        return { content: [{ type: 'text', text: `「${query}」に一致する表現は見つかりませんでした。` }] };
      }
      const output = results.slice(0, 50).map(r => `[${r.category}]\n${r.text}`).join('\n\n');
      return { content: [{ type: 'text', text: `「${query}」の検索結果: ${results.length}件${results.length > 50 ? '（上位50件表示）' : ''}\n\n${output}` }] };
    }
  );

  // Tool 2: カテゴリ一覧
  server.tool(
    'dictionary_categories',
    '辞書のカテゴリ（セクション・サブセクション）一覧を返す。',
    {},
    async () => {
      const dict = loadDictionary();
      const cats = [];
      dict.sections.forEach(section => {
        cats.push(`\n■ ${section.title}`);
        section.subsections.forEach(sub => {
          cats.push(`  ${sub.fullTitle}（${sub.items.length}件）`);
        });
      });
      return { content: [{ type: 'text', text: '辞書カテゴリ一覧:' + cats.join('\n') }] };
    }
  );

  // Tool 3: カテゴリの全表現取得
  server.tool(
    'dictionary_get_category',
    '指定カテゴリの全表現を返す。カテゴリ名の部分一致で検索。',
    { category: z.string().describe('カテゴリ名（例：「表情」「視線」「心理」「スマホ」）') },
    async ({ category }) => {
      const dict = loadDictionary();
      const q = category.toLowerCase();
      const matches = [];
      dict.sections.forEach(section => {
        section.subsections.forEach(sub => {
          if (section.title.toLowerCase().includes(q) || sub.fullTitle.toLowerCase().includes(q) || sub.title.toLowerCase().includes(q)) {
            matches.push({ title: `${section.title} > ${sub.fullTitle}`, items: sub.items });
          }
        });
      });
      if (matches.length === 0) {
        return { content: [{ type: 'text', text: `「${category}」に一致するカテゴリが見つかりません。` }] };
      }
      const output = matches.map(m => `【${m.title}】（${m.items.length}件）\n${m.items.join('\n')}`).join('\n\n');
      return { content: [{ type: 'text', text: output }] };
    }
  );

  // Tool 4: 場面・意図で表現を探す
  server.tool(
    'dictionary_find_expression',
    '場面や意図を説明して、辞書から合う表現を探す。辞書全体を文脈的に検索する。',
    { description: z.string().describe('どんな場面・感情の表現が欲しいか（例：「相手の嘘に気づいたが悟られたくない」）') },
    async ({ description }) => {
      const dict = loadDictionary();
      const keywords = description.replace(/[（）()「」『』、。・,.\-:：\d]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
      const scored = [];
      dict.sections.forEach(section => {
        section.subsections.forEach(sub => {
          sub.items.forEach(item => {
            let score = 0;
            const itemLower = item.toLowerCase();
            keywords.forEach(kw => { if (itemLower.includes(kw.toLowerCase())) score += 2; });
            if (/眉|目|視線|瞳|唇|口|額|頬|顎|肩|手|指|背筋|喉/.test(description) && /眉|目|視線|瞳|唇|口|額|頬|顎|肩|手|指|背筋|喉/.test(item)) score += 1;
            if (/怒|悲|喜|驚|恐|不安|緊張|動揺/.test(description) && /怒|悲|喜|驚|恐|不安|緊張|動揺/.test(item)) score += 1;
            if (score > 0) scored.push({ text: item, category: `${section.title} > ${sub.fullTitle}`, score });
          });
        });
      });
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 30);
      if (top.length === 0) {
        return { content: [{ type: 'text', text: `「${description}」に関連する表現が見つかりませんでした。` }] };
      }
      const output = top.map(r => `${r.text}\n  └ ${r.category}`).join('\n\n');
      return { content: [{ type: 'text', text: `「${description}」に関連する表現: ${top.length}件\n\n${output}` }] };
    }
  );

  return server;
}

// === Express + SSE transport ===
const app = express();

// Store transports for each session
const transports = {};

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  const server = createServer();
  transports[transport.sessionId] = { transport, server };

  res.on('close', () => {
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = transports[sessionId];
  if (!session) {
    res.status(400).json({ error: 'No active session' });
    return;
  }
  await session.transport.handlePostMessage(req, res);
});

// Health check
app.get('/', (req, res) => {
  res.json({ name: '小説執筆用辞書 MCP Server', status: 'running', tools: 4 });
});

app.listen(PORT, () => {
  console.log(`小説執筆用辞書 MCP Server running on port ${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
