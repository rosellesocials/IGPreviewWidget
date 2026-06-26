export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, pageUrl } = req.body;
  if (!token || !pageUrl) return res.status(400).json({ error: 'Missing token or pageUrl' });

  const NOTION_VERSION = '2022-06-28';
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };

  function extractIds(url) {
    const ids = [];
    const patterns = [
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi,
      /([a-f0-9]{32})/gi
    ];
    for (const p of patterns) {
      let m;
      while ((m = p.exec(url)) !== null) {
        const clean = m[1].replace(/-/g, '');
        if (!ids.includes(clean)) ids.push(clean);
      }
    }
    return ids;
  }

  function toUUID(id) {
    const c = id.replace(/-/g, '');
    return `${c.slice(0,8)}-${c.slice(8,12)}-${c.slice(12,16)}-${c.slice(16,20)}-${c.slice(20)}`;
  }

  function getImage(page) {
    if (page.cover) {
      if (page.cover.type === 'external') return page.cover.external?.url || null;
      if (page.cover.type === 'file') return page.cover.file?.url || null;
    }
    for (const key of Object.keys(page.properties || {})) {
      const prop = page.properties[key];
      if (prop.type === 'files' && prop.files?.length > 0) {
        const f = prop.files[0];
        if (f.type === 'external') return f.external?.url || null;
        if (f.type === 'file') return f.file?.url || null;
      }
    }
    return null;
  }

  function getTitle(page) {
    for (const key of Object.keys(page.properties || {})) {
      const prop = page.properties[key];
      if (prop.type === 'title' && prop.title?.length > 0) {
        return prop.title.map(t => t.plain_text).join('');
      }
    }
    return 'Untitled';
  }

  function getDate(page) {
    for (const key of Object.keys(page.properties || {})) {
      const prop = page.properties[key];
      if (prop.type === 'date' && prop.date?.start) return prop.date.start;
    }
    return null;
  }

  const ids = extractIds(pageUrl);
  if (ids.length === 0) return res.status(400).json({ error: 'No valid Notion ID found in URL.' });

  const debugLog = [];
  let dbId = null;

  for (const id of ids) {
    const uuid = toUUID(id);
    debugLog.push(`Trying ID: ${uuid}`);

    const dbRes = await fetch(`https://api.notion.com/v1/databases/${uuid}`, { headers });
    if (dbRes.ok) {
      dbId = uuid;
      debugLog.push(`Found as database: ${uuid}`);
      break;
    } else {
      const dbErr = await dbRes.json();
      debugLog.push(`Not a database (${dbRes.status}): ${dbErr.message}`);
    }

    const pgRes = await fetch(`https://api.notion.com/v1/pages/${uuid}`, { headers });
    if (pgRes.ok) {
      debugLog.push(`Found as page: ${uuid}, looking for child databases...`);
      const childRes = await fetch(`https://api.notion.com/v1/blocks/${uuid}/children?page_size=50`, { headers });
      if (childRes.ok) {
        const children = await childRes.json();
        for (const block of children.results) {
          debugLog.push(`Block type: ${block.type}`);
          if (block.type === 'child_database') {
            dbId = toUUID(block.id.replace(/-/g, ''));
            debugLog.push(`Found child_database: ${dbId}`);
            break;
          }
        }
      }
      if (dbId) break;
    } else {
      const pgErr = await pgRes.json();
      debugLog.push(`Not a page (${pgRes.status}): ${pgErr.message}`);
    }
  }

  if (!dbId) {
    return res.status(404).json({
      error: 'Could not find database. Debug: ' + debugLog.join(' | ')
    });
  }

  const qRes = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ page_size: 9 })
  });

  if (!qRes.ok) {
    const err = await qRes.json();
    return res.status(400).json({ error: 'Query failed: ' + err.message });
  }

  const data = await qRes.json();
  const items = data.results.map(page => ({
    title: getTitle(page),
    image: getImage(page),
    date: getDate(page),
    url: page.url
  }));

  return res.status(200).json({ success: true, items, databaseId: dbId });
}
