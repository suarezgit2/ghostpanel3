/**
 * Test script: Solve fresh Turnstile and test sendEmailVerifyCodeWithCaptcha
 * with action="register" (lowercase)
 */

const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_API_KEY;
const API_BASE = "https://api.manus.im";

async function solveTurnstile() {
  console.log("Resolvendo Turnstile...");
  const createResp = await fetch("https://api.2captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: TWOCAPTCHA_KEY,
      task: {
        type: "TurnstileTaskProxyless",
        websiteURL: "https://manus.im/login",
        websiteKey: "0x4AAAAAAA_sd0eRNCinWBgU",
      },
    }),
  });
  const createData = await createResp.json();
  if (createData.errorId) throw new Error(`2Captcha error: ${JSON.stringify(createData)}`);
  const taskId = createData.taskId;
  console.log(`Task: ${taskId}`);

  // Poll
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollResp = await fetch("https://api.2captcha.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: TWOCAPTCHA_KEY, taskId }),
    });
    const pollData = await pollResp.json();
    if (pollData.status === "ready") {
      console.log("Turnstile resolvido!");
      return pollData.solution.token;
    }
  }
  throw new Error("Timeout");
}

async function testSendVerify(email, action, cfToken) {
  console.log(`\nTestando sendEmailVerifyCodeWithCaptcha:`);
  console.log(`  email: ${email}`);
  console.log(`  action: "${action}" (type: ${typeof action})`);
  console.log(`  cfCaptchaCode: ${cfToken.substring(0, 30)}...`);
  
  const payload = { email, action, cfCaptchaCode: cfToken };
  console.log(`  Payload keys: ${Object.keys(payload).join(", ")}`);
  console.log(`  Payload JSON: ${JSON.stringify(payload).substring(0, 200)}...`);
  
  const resp = await fetch(`${API_BASE}/user.v1.UserAuthPublicService/SendEmailVerifyCodeWithCaptcha`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Origin": "https://manus.im",
      "Referer": "https://manus.im/",
    },
    body: JSON.stringify(payload),
  });
  
  const text = await resp.text();
  console.log(`  Status: ${resp.status}`);
  console.log(`  Response: ${text}`);
  
  return { status: resp.status, body: text };
}

async function main() {
  const email = `test${Date.now()}@lojasmesh.com`;
  
  // First: getUserPlatforms to check email (uses same token)
  const token1 = await solveTurnstile();
  
  console.log("\n--- getUserPlatforms first ---");
  const gpResp = await fetch(`${API_BASE}/user.v1.UserAuthPublicService/GetUserPlatforms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Origin": "https://manus.im",
      "Referer": "https://manus.im/",
    },
    body: JSON.stringify({ email, cfCaptchaCode: token1 }),
  });
  const gpText = await gpResp.text();
  console.log(`  getUserPlatforms: ${gpResp.status} - ${gpText}`);
  
  // Second Turnstile for sendEmailVerifyCode
  const token2 = await solveTurnstile();
  
  // Test with "register" (lowercase)
  await testSendVerify(email, "register", token2);
}

main().catch(console.error);
