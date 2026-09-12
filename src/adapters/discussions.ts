import { itemKey } from '../dedup.js';
import type { Ctx, Item, SourceConfig } from '../types.js';

// GitHub Discussions have no Atom feed and are not in the REST API (REST covers team
// discussions only), so this uses GraphQL. Query shape verified against the live schema.
const QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    discussions(first:15,orderBy:{field:CREATED_AT,direction:DESC}){
      nodes{ title url createdAt category{ name } }
    }
  }
}`;

export async function discussions(src: SourceConfig, ctx: Ctx): Promise<Item[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const [owner, name] = src.repo!.split('/');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), src.timeoutMs);
  let json: any;
  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST', signal: ac.signal,
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { owner, name } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } finally { clearTimeout(timer); }

  if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join('; '));

  return (json.data?.repository?.discussions?.nodes ?? []).map((n: any): Item => ({
    key: itemKey(src.id, n.url),
    sourceId: src.id, section: src.section,
    title: n.title, url: n.url,
    publishedAt: n.createdAt,
    snippet: n.category?.name ? `Kategori: ${n.category.name}` : undefined,
  }));
}
