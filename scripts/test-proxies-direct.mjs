import { getDb } from "../server/db.js";
import { proxies } from "../drizzle/schema.js";
import { httpRequest } from "../server/services/httpClient.js";
import { eq, and, isNull } from "drizzle-orm";

async function test() {
  try {
    const db = await getDb();
    if (!db) {
      console.error("Database not available");
      process.exit(1);
    }

    const availableProxies = await db
      .select()
      .from(proxies)
      .where(and(eq(proxies.enabled, true), isNull(proxies.lastUsedAt)))
      .limit(5);

    console.log(`Found ${availableProxies.length} available proxies to test.`);

    for (const proxy of availableProxies) {
      console.log(`Testing proxy: ${proxy.host}:${proxy.port}...`);
      const start = Date.now();
      try {
        const response = await httpRequest({
          method: "GET",
          url: "https://manus.im/login",
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36" },
          proxy: {
            id: proxy.id,
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
            protocol: proxy.protocol
          },
          timeout: 15
        });
        const duration = Date.now() - start;
        console.log(`✅ SUCCESS: ${proxy.host} responded in ${duration}ms (Status: ${response.status})`);
      } catch (err) {
        const duration = Date.now() - start;
        console.log(`❌ FAILED: ${proxy.host} failed after ${duration}ms: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("Test script error:", err);
  }
}

test();
