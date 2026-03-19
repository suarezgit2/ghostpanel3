import * as impers from "impers";

try {
  console.log("=== Testando impers com impersonate='chrome' ===\n");
  const r = await impers.get("https://tls.peet.ws/api/all", { impersonate: "chrome" });
  const data = r.json();
  
  console.log("STATUS:", r.status);
  console.log("\n--- TLS Fingerprint ---");
  console.log("JA3 Hash:", data.tls?.ja3_hash);
  console.log("JA4:", data.tls?.ja4);
  console.log("TLS Version:", data.tls?.version);
  console.log("Cipher Suites:", data.tls?.ciphers?.length, "ciphers");
  console.log("Extensions:", data.tls?.extensions?.length, "extensions");
  
  console.log("\n--- HTTP/2 Fingerprint ---");
  console.log("Akamai FP:", data.http2?.akamai_fingerprint);
  console.log("Sent Frames:", JSON.stringify(data.http2?.sent_frames?.slice(0, 3)));
  
  console.log("\n--- HTTP Info ---");
  console.log("HTTP Version:", data.http_version);
  console.log("User-Agent:", data.user_agent);
  console.log("IP:", data.ip);
  
  console.log("\n=== Agora testando com Node.js fetch padrão ===\n");
  const r2 = await fetch("https://tls.peet.ws/api/all");
  const data2 = await r2.json();
  
  console.log("STATUS:", r2.status);
  console.log("JA3 Hash:", data2.tls?.ja3_hash);
  console.log("JA4:", data2.tls?.ja4);
  console.log("HTTP Version:", data2.http_version);
  console.log("Akamai FP:", data2.http2?.akamai_fingerprint);
  console.log("User-Agent:", data2.user_agent);
  
  console.log("\n=== COMPARAÇÃO ===");
  console.log("JA3 iguais?", data.tls?.ja3_hash === data2.tls?.ja3_hash ? "SIM (RUIM)" : "NÃO (BOM - são diferentes)");
  console.log("impers JA3:", data.tls?.ja3_hash);
  console.log("fetch  JA3:", data2.tls?.ja3_hash);
  
} catch(e) {
  console.error("ERROR:", e.message);
  console.error(e.stack);
}
