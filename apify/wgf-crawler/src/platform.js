// Minimal Apify platform layer with no SDK: input, dataset and key-value store through the Apify API.
// Locally (no APIFY_TOKEN) it reads ./storage/input.json and writes JSON files to ./storage/.
import fs from "node:fs";
import path from "node:path";

const API = process.env.APIFY_API_BASE_URL || "https://api.apify.com/v2";
const TOKEN = process.env.APIFY_TOKEN;
const ON_PLATFORM = Boolean(TOKEN && process.env.APIFY_DEFAULT_DATASET_ID);
const LOCAL_DIR = path.resolve("storage");

async function api(method, url, body, contentType = "application/json") {
  const res = await fetch(`${API}${url}${url.includes("?") ? "&" : "?"}token=${TOKEN}`, {
    method,
    headers: body ? { "content-type": contentType } : {},
    body: body == null ? undefined : contentType === "application/json" ? JSON.stringify(body) : body,
  });
  if (!res.ok) throw new Error(`Apify API ${method} ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}

export async function getInput() {
  if (!ON_PLATFORM) {
    const f = path.join(LOCAL_DIR, "input.json");
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  }
  const store = process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID;
  const key = process.env.APIFY_INPUT_KEY || "INPUT";
  try { return (await api("GET", `/key-value-stores/${store}/records/${key}`)) || {}; } catch { return {}; }
}

const localItems = [];
export async function pushData(items) {
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) return;
  if (!ON_PLATFORM) { localItems.push(...list); return; }
  for (let i = 0; i < list.length; i += 200) {
    await api("POST", `/datasets/${process.env.APIFY_DEFAULT_DATASET_ID}/items`, list.slice(i, i + 200));
  }
}

export async function setValue(key, value) {
  if (!ON_PLATFORM) {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_DIR, `${key}.json`), JSON.stringify(value, null, 2));
    return;
  }
  await api("PUT", `/key-value-stores/${process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID}/records/${key}`, value);
}

export async function flushLocal() {
  if (ON_PLATFORM) return;
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_DIR, "dataset.json"), JSON.stringify(localItems, null, 2));
}

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
