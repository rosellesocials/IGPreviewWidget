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

  // Extract any ID from the URL (32 hex chars, with or without dashes)
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

  // Format ID as UUID
  function toUUID(id) {
    const c = id.replace(/-/g, '');
    return `${c.slice(0,8)}-${c.slice(8,12)}-${c.slice(12,16)}-${c.slice(16,20)}-${c.slice(20)}`;
  }

  // Try to retrieve a Notion object by ID
  async function tryRetrieve(id) {
    const uuid = toUUID(id);
    // Try as database first
    const dbRes = await fetch(`https://api.notion.com/v1/databases/${uuid}`, { headers });
    if (dbRes.ok) return { type: 'database', id: uuid, data: await dbRes.json() };

    // Try as page
    const pgRes = await fetch(`https://api.notion.com/v1/pages/${uuid}`, { headers });
    if (pgRes.ok) return { type: 'page', id: uuid, data: await pgRes.json() };

    return null;
  }

  // Query a database and return items
  async function queryDatabase(dbId) {
    const qRes = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ page_size: 9, sorts: [{ timestamp: 'created_time', direction: 'descending' }] })
    });
    if (!qRes.ok) {
      const err = await qRes.json();
      throw new Error(err.message || 'Failed to query database');
    }
    return await qRes.json();
  }

  // Get children blocks of a page to find inline databases
  async function getPageChildren(pageId) {
    const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, { headers });
    if (!res.ok) return null;
    return await res.json();
  }

  // Extract image from a Notion page result
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
      if (prop.type === 'url' && prop.url && /\.(jpg|jpeg|png|gif|webp)/i.test(prop.url)) {
        return prop.url;
      }
    }
    return null;
  }

  // Extract title from a Notion page result
  function getTitle(page) {
    for (const key of Object.keys(page.properties || {})) {
      const prop = page.properties[key];
      if (prop.type === 'title' && prop.title?.length > 0) {
        return prop.title.map(t => t.plain_text).join('');
      }
    }
    return 'Untitled';
  }

  // Extract date from a Notion page result
  function getDate(page) {
    for (const key of Object.keys(page.properties || {})) {
      const prop = page.properties[key];
      if (prop.type === 'date' && prop.date?.start) return prop.date.start;
    }
    return null;
  }

  try {
    const ids = extractIds(pageUrl);
    if (ids.length === 0) return res.status(400).json({ error: 'No valid Notion ID found in URL.' });

    let dbId = null;

    // Try each ID: if it's a database, use it directly; if it's a page, look for child databases
    for (const id of ids) {
      const obj = await tryRetrieve(id);
      if (!obj) continue;

      if (obj.type === 'database') {
        dbId = obj.id;
        break;
      }

      if (obj.type === 'page') {
        // Look for child databases inside this page
        const children = await getPageChildren(obj.id);
        if (children?.results) {
          for (const block of children.results) {
            if (block.type === 'child_database') {
              dbId = toUUID(block.id.replace(/-/g, ''));
              break;
            }
            if (block.type === 'linked_database' && block.linked_database?.database_id) {
              dbId = block.linked_database.database_id;
              break;
            }
          }
        }
        if (dbId) break;
      }
    }

    if (!dbId) {
      return res.status(404).json({
        error: 'Could not find a database from the provided URL. Make sure your integration is connected to the database.'
      });
    }

    const data = await queryDatabase(dbId);

    const items = data.results.map(page => ({
      title: getTitle(page),
      image: getImage(page),
      date: getDate(page),
      url: page.url
    }));

    return res.status(200).json({ success: true, items, databaseId: dbId });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
