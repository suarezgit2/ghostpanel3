import https from 'https';

const proxiesToTest = [
  { host: '198.46.241.87', port: 6622, user: 'ghostpanel', pass: 'ghostpanel' },
  // Add more if known, but I'll try to get them from the user's log
];

async function testProxy(proxy) {
  console.log(`Testing ${proxy.host}:${proxy.port}...`);
  const proxyUrl = `http://${proxy.user}:${proxy.pass}@${proxy.host}:${proxy.port}`;
  
  // We'll use a simple curl command via child_process to avoid complex node proxy setup
  // and to test if the OS can reach it.
  const { exec } = await import('child_process');
  const util = await import('util');
  const execPromise = util.promisify(exec);

  try {
    const { stdout, stderr } = await execPromise(`curl -x ${proxyUrl} -I https://manus.im/login --connect-timeout 10 --max-time 15`);
    console.log(`✅ SUCCESS ${proxy.host}:`);
    console.log(stdout.split('\n')[0]); // Print first line of headers
  } catch (err) {
    console.log(`❌ FAILED ${proxy.host}: ${err.message}`);
  }
}

async function run() {
  for (const p of proxiesToTest) {
    await testProxy(p);
  }
}

run();
