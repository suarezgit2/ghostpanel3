/**
 * Test different action values for sendEmailVerifyCodeWithCaptcha
 * to find which one the API accepts
 */

const API_BASE = "https://api.manus.im";

// First, solve a Turnstile token via 2Captcha
const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_API_KEY;
const SITE_KEY = "0x4AAAAAAA_sd0eRNCinWBgU";
const PAGE_URL = "https://manus.im/login";

async function solveTurnstile() {
  console.log("Resolvendo Turnstile...");
  const createResp = await fetch("https://api.2captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: TWOCAPTCHA_KEY,
      task: {
        type: "TurnstileTaskProxyless",
        websiteURL: PAGE_URL,
        websiteKey: SITE_KEY,
      },
    }),
  });
  const createData = await createResp.json();
  if (createData.errorId) throw new Error(`2Captcha create error: ${JSON.stringify(createData)}`);
  const taskId = createData.taskId;
  console.log(`Task criada: ${taskId}`);

  // Poll for result
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const resultResp = await fetch("https://api.2captcha.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: TWOCAPTCHA_KEY, taskId }),
    });
    const resultData = await resultResp.json();
    if (resultData.status === "ready") {
      console.log("Turnstile resolvido!");
      return resultData.solution.token;
    }
  }
  throw new Error("Timeout resolvendo Turnstile");
}

async function testAction(email, cfCaptchaCode, actionValue) {
  console.log(`\nTestando action="${actionValue}"...`);
  
  const resp = await fetch(`${API_BASE}/user.v1.UserAuthPublicService/SendEmailVerifyCodeWithCaptcha`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "Origin": "https://manus.im",
      "Referer": "https://manus.im/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({ email, action: actionValue, cfCaptchaCode }),
  });
  
  const text = await resp.text();
  console.log(`  Status: ${resp.status}`);
  console.log(`  Response: ${text.substring(0, 300)}`);
  return { status: resp.status, body: text };
}

async function testActionEnum(email, cfCaptchaCode, actionValue) {
  console.log(`\nTestando action=${actionValue} (numérico)...`);
  
  const resp = await fetch(`${API_BASE}/user.v1.UserAuthPublicService/SendEmailVerifyCodeWithCaptcha`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "Origin": "https://manus.im",
      "Referer": "https://manus.im/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({ email, action: actionValue, cfCaptchaCode }),
  });
  
  const text = await resp.text();
  console.log(`  Status: ${resp.status}`);
  console.log(`  Response: ${text.substring(0, 300)}`);
  return { status: resp.status, body: text };
}

async function main() {
  const email = `test${Date.now()}@lojasmesh.com`;
  console.log(`Email de teste: ${email}`);
  
  // Solve Turnstile first
  const token = await solveTurnstile();
  
  // Test different action values
  const actions = [
    "REGISTER",
    "register",
    "Register",
    "SIGN_UP",
    "sign_up",
    "signup",
    "EMAIL_REGISTER",
    "email_register",
    "VERIFY",
    "verify",
    "SEND_CODE",
    "send_code",
    "ACTION_REGISTER",
    "EMAIL_VERIFY_CODE_ACTION_REGISTER",
  ];
  
  for (const action of actions) {
    const result = await testAction(email, token, action);
    if (!result.body.includes("unknown action type") && !result.body.includes("error")) {
      console.log(`\n✅ SUCESSO com action="${action}"!`);
      break;
    }
    // Small delay between tests
    await new Promise((r) => setTimeout(r, 500));
  }
  
  // Also test numeric enum values (protobuf enums are often numeric)
  console.log("\n--- Testando valores numéricos (protobuf enum) ---");
  for (let i = 0; i <= 5; i++) {
    const result = await testActionEnum(email, token, i);
    if (!result.body.includes("unknown action type") && !result.body.includes("error")) {
      console.log(`\n✅ SUCESSO com action=${i}!`);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch(console.error);
