/**
 * Ghost - Utility Helpers
 * delay, nanoid, dcr-encoder, logger
 *
 * v9.0 CHANGES (1 Billion+ Combinatorial Space):
 * - generatePassword: 500 words × 15 symbols × 12 patterns = ~1.1B combinations
 * - generateEmailPrefix: 500 first names × 300 last names × 17 patterns = ~5B combinations
 * - Words sourced from: US Census names, international names, gaming/tech culture
 * - Every pattern produces outputs that look like real human-chosen credentials
 */

import crypto from "crypto";
import { getDb } from "../db";
import { logs } from "../../drizzle/schema";

// ============================================================
// DELAY
// ============================================================

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export function randomDelay(minMs: number, maxMs: number, signal?: AbortSignal): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return sleep(Math.round(delay), signal);
}

export function gaussianDelay(meanMs: number, stdDevMs: number, minMs?: number, maxMs?: number, signal?: AbortSignal): Promise<void> {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  let delay = meanMs + z0 * stdDevMs;
  if (minMs !== undefined) delay = Math.max(delay, minMs);
  if (maxMs !== undefined) delay = Math.min(delay, maxMs);
  return sleep(Math.round(delay), signal);
}

export const STEP_DELAYS = {
  afterTurnstile: (signal?: AbortSignal) => gaussianDelay(2000, 800, 1000, 4000, signal),
  afterEmailCheck: (signal?: AbortSignal) => gaussianDelay(1500, 500, 800, 3000, signal),
  afterEmailCodeSent: (signal?: AbortSignal) => gaussianDelay(3000, 1000, 1500, 6000, signal),
  afterEmailCodeReceived: (signal?: AbortSignal) => gaussianDelay(4000, 1500, 2000, 8000, signal),
  afterRegistration: (signal?: AbortSignal) => gaussianDelay(8000, 3000, 4000, 15000, signal),
  afterSmsSent: (signal?: AbortSignal) => gaussianDelay(2000, 800, 1000, 4000, signal),
  afterSmsCodeReceived: (signal?: AbortSignal) => gaussianDelay(3000, 1000, 1500, 6000, signal),
  betweenAccounts: (signal?: AbortSignal) => gaussianDelay(60000, 25000, 30000, 120000, signal),
};

// ============================================================
// NANOID
// ============================================================

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateClientId(length = 22): string {
  const bytes = crypto.randomBytes(length);
  let id = "";
  for (let i = 0; i < length; i++) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
}

export function generateRandomString(length: number, charset?: string): string {
  const chars = charset || ALPHABET;
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

// ============================================================
// PASSWORD GENERATOR — 500 words × 15 symbols × 12 patterns ≈ 1.1B+
// ============================================================

/**
 * 500 password words organized by category.
 * Sourced from common password studies, gaming culture, and natural language.
 * Each word is capitalized (Title Case) as humans typically do.
 */
const PASSWORD_WORDS = [
  // ── Nature & Weather (60) ──
  "Sunrise", "Sunset", "Thunder", "Storm", "Blaze", "Frost", "River", "Ocean",
  "Mountain", "Forest", "Meadow", "Valley", "Canyon", "Desert", "Glacier",
  "Aurora", "Breeze", "Tempest", "Cascade", "Horizon", "Eclipse", "Solstice",
  "Monsoon", "Cyclone", "Tornado", "Tsunami", "Volcano", "Avalanche", "Wildfire", "Rainbow",
  "Blossom", "Pebble", "Coral", "Driftwood", "Ember", "Flicker", "Geyser", "Harbor",
  "Iceberg", "Jungle", "Kelp", "Lagoon", "Marsh", "Oasis", "Prairie", "Quarry",
  "Rapids", "Savanna", "Tundra", "Upstream", "Waterfall", "Zephyr", "Blizzard", "Drizzle",
  "Hailstone", "Lightning", "Rainfall", "Snowfall", "Starlight", "Moonbeam",
  // ── Animals (60) ──
  "Dragon", "Phoenix", "Eagle", "Tiger", "Falcon", "Wolf", "Panther", "Cobra",
  "Hawk", "Raven", "Dolphin", "Jaguar", "Mustang", "Viper", "Griffin",
  "Scorpion", "Sparrow", "Condor", "Leopard", "Stallion", "Buffalo", "Coyote",
  "Mantis", "Osprey", "Pelican", "Cheetah", "Gazelle", "Gorilla", "Hamster", "Iguana",
  "Jackal", "Koala", "Lynx", "Moose", "Narwhal", "Otter", "Penguin", "Quail",
  "Raptor", "Salmon", "Toucan", "Urchin", "Vulture", "Walrus", "Zebra", "Badger",
  "Caribou", "Dingo", "Ferret", "Gecko", "Heron", "Ibis", "Kestrel", "Lemur",
  "Marmot", "Newt", "Ocelot", "Puma",
  // ── Tech & Sci-Fi (60) ──
  "Pixel", "Turbo", "Omega", "Alpha", "Delta", "Sigma", "Nexus", "Cyber",
  "Quantum", "Photon", "Neutron", "Proton", "Vector", "Matrix", "Binary",
  "Cipher", "Vertex", "Prism", "Helix", "Quasar", "Nebula", "Pulsar",
  "Plasma", "Fusion", "Orbital", "Android", "Bitcoin", "Cloud", "Docker", "Ethernet",
  "Firewall", "Gateway", "Hadoop", "Ionic", "Java", "Kernel", "Lambda", "Mongo",
  "Neural", "Oxide", "Python", "Query", "Redis", "Syntax", "Tensor", "Ubuntu",
  "Vagrant", "Webpack", "Xenon", "Yaml", "Zigbee", "Ansible", "Blazor", "Cargo",
  "Daemon", "Elixir", "Flutter", "Grafana", "Heroku",
  // ── Everyday Objects & Food (60) ──
  "Coffee", "Crystal", "Silver", "Golden", "Shadow", "Mystic", "Cosmic",
  "Brave", "Comet", "Ranger", "Ninja", "Vortex", "Beacon", "Anchor",
  "Compass", "Lantern", "Marble", "Velvet", "Copper", "Bronze", "Ivory",
  "Obsidian", "Sapphire", "Emerald", "Diamond", "Butter", "Caramel", "Donut", "Espresso",
  "Fudge", "Granola", "Honey", "Icing", "Jasmine", "Kiwi", "Lemon", "Mango",
  "Nutmeg", "Olive", "Papaya", "Quinoa", "Raisin", "Saffron", "Truffle", "Vanilla",
  "Waffle", "Almond", "Biscuit", "Cinnamon", "Ginger", "Hazelnut", "Lavender", "Maple",
  "Pepper", "Pumpkin", "Sesame", "Thyme", "Walnut", "Cocoa",
  // ── Abstract & Emotions (60) ──
  "Spirit", "Zenith", "Serenity", "Harmony", "Valor", "Triumph", "Legacy",
  "Fortune", "Destiny", "Liberty", "Justice", "Wisdom", "Courage", "Honor",
  "Glory", "Victory", "Passion", "Radiant", "Stellar", "Infinite", "Eternal",
  "Supreme", "Majestic", "Phantom", "Enigma", "Bliss", "Chaos", "Dream", "Faith",
  "Grace", "Hope", "Impulse", "Karma", "Lucid", "Mercy", "Noble", "Oath",
  "Peace", "Quest", "Rebel", "Serene", "Truth", "Unity", "Vivid", "Wonder",
  "Ardent", "Bright", "Candid", "Daring", "Eager", "Fierce", "Gentle", "Humble",
  "Jovial", "Keen", "Loyal", "Mellow", "Nimble", "Proud",
  // ── Colors & Elements (40) ──
  "Crimson", "Azure", "Scarlet", "Indigo", "Amber", "Cobalt", "Titanium",
  "Carbon", "Neon", "Chrome", "Platinum", "Mercury", "Onyx", "Jade",
  "Ruby", "Topaz", "Garnet", "Opal", "Pearl", "Coral", "Magenta", "Teal",
  "Violet", "Maroon", "Ivory", "Slate", "Copper", "Brass", "Steel", "Iron",
  "Zinc", "Nickel", "Argon", "Boron", "Helium", "Lithium", "Neon", "Radon",
  "Silicon", "Sulfur",
  // ── Mythology & Fantasy (50) ──
  "Apollo", "Athena", "Zeus", "Odin", "Thor", "Loki", "Freya", "Hades",
  "Hermes", "Artemis", "Poseidon", "Ares", "Hera", "Titan", "Olympus",
  "Valkyrie", "Fenrir", "Ragnar", "Viking", "Spartan", "Samurai", "Shogun",
  "Ronin", "Templar", "Paladin", "Wizard", "Sorcerer", "Druid", "Warlock", "Mystic",
  "Golem", "Hydra", "Kraken", "Minotaur", "Sphinx", "Chimera", "Basilisk", "Cerberus",
  "Pegasus", "Unicorn", "Wyvern", "Banshee", "Djinn", "Goblin", "Hobbit", "Ogre",
  "Troll", "Wraith", "Lich", "Specter",
  // ── Places & Geography (50) ──
  "Alaska", "Berlin", "Cairo", "Denver", "Essex", "Florence", "Geneva", "Houston",
  "Istanbul", "Jakarta", "Kyoto", "Lima", "Madrid", "Naples", "Oslo",
  "Prague", "Quebec", "Reno", "Sydney", "Tokyo", "Utrecht", "Venice", "Warsaw",
  "Zurich", "Athens", "Boston", "Dallas", "Dublin", "Helsinki", "Lisbon",
  "Memphis", "Milan", "Munich", "Oxford", "Paris", "Portland", "Salem", "Seattle",
  "Tampa", "Vienna", "Austin", "Brooklyn", "Camden", "Detroit", "Fresno", "Glasgow",
  "Havana", "Juneau", "Kingston", "Nairobi",
  // ── Music & Arts (60) ──
  "Melody", "Rhythm", "Tempo", "Chord", "Lyric", "Sonata", "Ballad", "Anthem",
  "Chorus", "Verse", "Bridge", "Refrain", "Octave", "Treble", "Bass",
  "Soprano", "Tenor", "Baritone", "Allegro", "Adagio", "Forte", "Piano",
  "Staccato", "Legato", "Crescendo", "Vivace", "Andante", "Presto", "Maestro", "Virtuoso",
  "Canvas", "Mosaic", "Fresco", "Sketch", "Palette", "Easel", "Charcoal", "Pastel",
  "Acrylic", "Gouache", "Sculpture", "Gallery", "Museum", "Studio", "Atelier", "Collage",
  "Montage", "Tableau", "Portrait", "Mural", "Abstract", "Baroque", "Gothic", "Modern",
  "Vintage", "Retro", "Classic", "Fusion", "Remix", "Encore",
];

const PASSWORD_SYMBOLS = ["!", "@", "#", "$", "%", "&", "*", "?", "^", "+", "=", "~", "-", ".", "_"];

/**
 * Generate a human-like password with 1.1B+ possible combinations.
 *
 * v9.0: 500 words × 15 symbols × 12 weighted patterns.
 * Combinatorial breakdown:
 *   - word+num4+sym:       500 × 9000 × 15 = 67.5M
 *   - word+sym+num4:       500 × 15 × 9000 = 67.5M
 *   - word+num2+sym+word:  500 × 90 × 15 × 500 = 337.5M
 *   - word+word+num2:      500 × 500 × 90 = 22.5M
 *   - word+sym+word+num2:  500 × 15 × 500 × 90 = 337.5M
 *   - word+word+num3:      500 × 500 × 900 = 225M
 *   - word+num4:           500 × 9000 = 4.5M
 *   - word+num2+word:      500 × 90 × 500 = 22.5M
 *   - word+year:           500 × 10 = 5K
 *   - word+mmdd:           500 × 336 = 168K
 *   - word+num3+sym:       500 × 900 × 15 = 6.75M
 *   - word+word+sym:       500 × 500 × 15 = 3.75M
 *   TOTAL: ~1,095,173,000 (1.1B)
 */
export function generatePassword(length = 16): string {
  const w1 = PASSWORD_WORDS[Math.floor(Math.random() * PASSWORD_WORDS.length)];
  const w2 = PASSWORD_WORDS[Math.floor(Math.random() * PASSWORD_WORDS.length)];
  const sym = PASSWORD_SYMBOLS[Math.floor(Math.random() * PASSWORD_SYMBOLS.length)];
  const num4 = String(Math.floor(Math.random() * 9000) + 1000);
  const num3 = String(Math.floor(Math.random() * 900) + 100);
  const num2 = String(Math.floor(Math.random() * 90) + 10);
  const year = String(Math.floor(Math.random() * 10) + 2016);
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, "0");

  const roll = Math.random();
  let password: string;

  if (roll < 0.15) {
    password = `${w1}${num4}${sym}`;                    // Sunrise4521!
  } else if (roll < 0.25) {
    password = `${w1}${sym}${num4}`;                    // Dragon!2024
  } else if (roll < 0.40) {
    password = `${w1}${num2}${sym}${w2}`;               // Storm42!Fire
  } else if (roll < 0.50) {
    password = `${w1}${w2}${num2}`;                     // SilverFox99
  } else if (roll < 0.65) {
    password = `${w1}${sym}${w2}${num2}`;               // Thunder!Eagle42
  } else if (roll < 0.78) {
    password = `${w1}${w2}${num3}`;                     // CosmicRaven789
  } else if (roll < 0.83) {
    password = `${w1}${num4}`;                          // Phoenix2847
  } else if (roll < 0.88) {
    password = `${w1}${num2}${w2}`;                     // Blaze42Storm
  } else if (roll < 0.91) {
    password = `${w1}${year}`;                          // Coffee2024
  } else if (roll < 0.94) {
    password = `${w1}${month}${day}`;                   // Phoenix0315
  } else if (roll < 0.97) {
    password = `${w1}${num3}${sym}`;                    // Crystal789#
  } else {
    password = `${w1}${w2}${sym}`;                      // ThunderStorm!
  }

  if (password.length < length) {
    const extra = generateRandomString(length - password.length, "abcdefghijklmnopqrstuvwxyz0123456789");
    return password + extra;
  }
  return password.substring(0, length);
}

// ============================================================
// EMAIL PREFIX GENERATOR — 500 first × 300 last × 17 patterns ≈ 5B+
// ============================================================

/**
 * 500 first names: US Census top names + international + gender-neutral.
 */
const EMAIL_FIRST_NAMES = [
  // ── English Male (100) ──
  "james", "john", "robert", "michael", "william", "david", "richard", "joseph",
  "thomas", "charles", "daniel", "matthew", "anthony", "mark", "donald",
  "steven", "paul", "andrew", "joshua", "kenneth", "kevin", "brian",
  "george", "timothy", "ronald", "edward", "jason", "jeffrey", "ryan",
  "jacob", "gary", "nicholas", "eric", "jonathan", "stephen", "larry",
  "justin", "scott", "brandon", "benjamin", "samuel", "raymond", "gregory",
  "frank", "alexander", "patrick", "jack", "dennis", "jerry", "tyler",
  "aaron", "adam", "alan", "albert", "arthur", "billy", "bobby", "bruce",
  "carl", "christian", "christopher", "clarence", "craig", "dale", "darren",
  "dean", "derek", "dominic", "douglas", "dwight", "dylan", "earl",
  "eddie", "eugene", "evan", "floyd", "francis", "fred", "gerald", "glen",
  "gordon", "grant", "harold", "harry", "henry", "howard", "ian", "isaac",
  "ivan", "jesse", "joel", "johnny", "keith", "lance", "leon", "lloyd",
  "marcus", "marshall", "martin", "melvin",
  // ── English Female (100) ──
  "mary", "patricia", "jennifer", "linda", "barbara", "elizabeth", "susan",
  "jessica", "sarah", "karen", "emma", "olivia", "ava", "isabella",
  "sophia", "mia", "charlotte", "amelia", "harper", "evelyn", "abigail",
  "emily", "madison", "chloe", "grace", "victoria", "penelope", "riley",
  "layla", "zoey", "nora", "lily", "eleanor", "hannah", "lillian",
  "addison", "aubrey", "stella", "natalie", "zoe", "leah", "hazel",
  "violet", "aurora", "savannah", "audrey", "brooklyn", "bella", "claire", "skylar",
  "alice", "andrea", "angela", "ann", "anna", "annie", "ashley", "becky",
  "beth", "betty", "bonnie", "brenda", "brittany", "carol", "caroline", "catherine",
  "cheryl", "christina", "cindy", "colleen", "crystal", "cynthia", "dana", "dawn",
  "deborah", "denise", "diana", "donna", "doris", "dorothy", "edith", "eileen",
  "elaine", "ellen", "erica", "esther", "fiona", "florence", "gail", "georgia",
  "gloria", "heather", "helen", "holly", "irene", "jackie", "jade", "janet",
  "janice", "jean", "jill", "joan",
  // ── Gender-Neutral (50) ──
  "alex", "chris", "sam", "taylor", "jordan", "casey", "morgan", "riley",
  "drew", "blake", "skyler", "quinn", "reese", "avery", "logan",
  "cameron", "dakota", "finley", "hayden", "jamie", "kendall", "parker",
  "peyton", "rowan", "sage", "spencer", "tatum", "devon", "emery", "harley",
  "jessie", "kerry", "kim", "lee", "leslie", "lynn", "pat", "robin",
  "sandy", "shannon", "shawn", "shelby", "stacy", "terry", "tracy", "val",
  "wren", "ash", "bay", "reed",
  // ── Portuguese & Spanish (60) ──
  "mateo", "diego", "rafael", "carlos", "miguel", "pedro", "andre", "bruno",
  "caio", "davi", "enzo", "felipe", "gabriel", "gustavo", "henrique",
  "igor", "joao", "leonardo", "marcelo", "nicolas", "otavio", "paulo",
  "renato", "sergio", "thiago", "vinicius", "wagner", "yuri", "adriana", "beatriz",
  "camila", "daniela", "elena", "fernanda", "giovanna", "helena", "isabela", "juliana",
  "karla", "larissa", "leticia", "manuela", "natalia", "priscila", "raquel", "sabrina",
  "tatiana", "valentina", "vanessa", "yasmin", "alejandro", "antonio", "cesar", "eduardo",
  "fernando", "gonzalo", "hector", "javier", "pablo", "ricardo",
  // ── German & French (50) ──
  "hans", "klaus", "stefan", "andreas", "bernd", "christoph", "dieter", "florian",
  "gerhard", "helmut", "jens", "karl", "lukas", "markus", "norbert",
  "oliver", "peter", "rainer", "tobias", "ulrich", "volker", "werner",
  "wolfgang", "anke", "birgit", "claudia", "dagmar", "eva", "franziska", "greta",
  "heike", "inga", "katrin", "lena", "monika", "petra", "sabine", "ursula",
  "antoine", "baptiste", "claude", "dominique", "emile", "francois", "guillaume", "henri",
  "jacques", "laurent", "marcel", "nicolas",
  // ── Asian (60) ──
  "akira", "daichi", "haruto", "hiroshi", "ichiro", "kenji", "makoto", "naoki",
  "riku", "satoshi", "takeshi", "yuki", "aiko", "hana", "kaori",
  "mei", "sakura", "yui", "chen", "fang", "gang", "hai", "jian",
  "kai", "lei", "ming", "ping", "qiang", "rui", "shan", "tao",
  "wei", "xin", "yan", "zhi", "ananya", "arjun", "deepak", "gaurav",
  "hari", "indra", "kiran", "lakshmi", "mohan", "nisha", "priya", "rahul",
  "sanjay", "tanvi", "usha", "vijay", "soo", "hyun", "jin", "min",
  "sung", "young", "chul", "hee", "joon", "woo",
  // ── African & Middle Eastern (30) ──
  "amara", "chioma", "emeka", "fatima", "ibrahim", "kwame", "lamine", "musa",
  "nadia", "omar", "rashid", "salim", "tariq", "yusuf", "zainab",
  "aisha", "bakari", "dalia", "essam", "farid", "ghazi", "hamza", "idris",
  "jalal", "khalid", "layla", "malik", "nabil", "qadir", "rami",
  // ── Modern/Trendy (50) ──
  "aiden", "brayden", "cayden", "declan", "easton", "finn", "grayson", "hudson",
  "jaxon", "kayden", "landon", "mason", "nolan", "oakley", "paxton",
  "ryder", "sawyer", "tucker", "wyatt", "xander", "zander", "aria",
  "brielle", "cora", "delilah", "ember", "freya", "gemma", "hadley", "isla",
  "juniper", "kinsley", "luna", "maeve", "nova", "olive", "piper", "rosie",
  "sienna", "thea", "una", "vera", "willow", "xiomara", "yara", "zelda",
  "asher", "beckett", "caleb", "ezra",
];

/**
 * 300 last names: US Census + international surnames.
 */
const EMAIL_LAST_NAMES = [
  // ── Common English (80) ──
  "smith", "johnson", "williams", "brown", "jones", "garcia", "miller",
  "davis", "wilson", "anderson", "taylor", "thomas", "jackson", "white",
  "harris", "martin", "thompson", "young", "allen", "king", "wright",
  "scott", "green", "baker", "adams", "nelson", "hill", "carter", "mitchell",
  "roberts", "turner", "phillips", "campbell", "parker", "evans", "edwards",
  "collins", "stewart", "sanchez", "morris", "rogers", "reed", "cook",
  "morgan", "bell", "murphy", "bailey", "rivera", "cooper", "richardson",
  "cox", "howard", "ward", "torres", "peterson", "gray", "ramirez",
  "james", "watson", "brooks", "kelly", "sanders", "price", "bennett",
  "wood", "barnes", "ross", "henderson", "coleman", "jenkins", "perry",
  "powell", "long", "patterson", "hughes", "flores", "washington", "butler", "simmons",
  // ── Portuguese & Spanish (60) ──
  "silva", "santos", "oliveira", "souza", "lima", "pereira", "costa",
  "ferreira", "almeida", "ribeiro", "carvalho", "gomes", "martins", "araujo",
  "barbosa", "cardoso", "correia", "cunha", "dias", "duarte", "fonseca",
  "freitas", "lopes", "machado", "medeiros", "mendes", "monteiro", "moreira",
  "nascimento", "nunes", "pinto", "ramos", "reis", "rocha", "rodrigues",
  "teixeira", "vieira", "fernandez", "lopez", "gonzalez", "rodriguez", "martinez",
  "hernandez", "castillo", "delgado", "dominguez", "espinoza", "fuentes", "guerrero",
  "gutierrez", "herrera", "jimenez", "mendoza", "morales", "navarro", "ortega",
  "padilla", "reyes", "romero", "salazar", "vargas", "vega",
  // ── German & French (40) ──
  "mueller", "schmidt", "schneider", "fischer", "weber", "meyer", "wagner",
  "becker", "schulz", "hoffmann", "koch", "richter", "wolf", "klein",
  "zimmermann", "braun", "hartmann", "krueger", "lange", "werner", "lehmann",
  "schmitt", "krause", "frank", "berger", "bernard", "bonnet", "dubois",
  "durand", "fontaine", "girard", "lambert", "leroy", "moreau", "petit",
  "richard", "robert", "roux", "simon", "thomas",
  // ── Asian (60) ──
  "tanaka", "yamamoto", "watanabe", "suzuki", "takahashi", "nakamura",
  "kobayashi", "saito", "kato", "yoshida", "yamada", "sasaki", "yamaguchi",
  "matsumoto", "inoue", "kimura", "hayashi", "shimizu", "yamazaki", "mori",
  "chen", "wang", "zhang", "liu", "yang", "huang", "zhao", "wu",
  "zhou", "xu", "sun", "ma", "zhu", "hu", "guo", "lin",
  "he", "gao", "luo", "zheng", "kim", "lee", "park", "choi",
  "jung", "kang", "cho", "yoon", "jang", "lim", "han", "oh",
  "shin", "seo", "kwon", "hwang", "ahn", "song",
  // ── Indian & African (30) ──
  "singh", "kumar", "sharma", "patel", "gupta", "mehta", "joshi", "verma",
  "mishra", "reddy", "nair", "rao", "das", "bhat", "iyer",
  "okafor", "mensah", "diallo", "traore", "toure", "ndiaye", "mbeki",
  "achebe", "osei", "kamara", "sesay", "conteh", "bangura", "koroma", "jalloh",
  // ── Misc International (30) ──
  "novak", "horvat", "kowalski", "nowak", "wisniewska", "popov", "ivanov",
  "petrov", "sokolov", "volkov", "kuznetsov", "morozov", "smirnov", "kozlov",
  "lebedev", "eriksson", "johansson", "larsson", "nilsson", "olsson",
  "hansen", "jensen", "nielsen", "pedersen", "christensen", "madsen", "andersen",
  "rasmussen", "petersen", "sorensen",
];

/**
 * Nickname components for gaming/internet-style prefixes.
 */
const NICK_PREFIXES = [
  "cool", "dark", "fast", "wild", "epic", "pro", "super", "mega", "ultra",
  "neo", "cyber", "tech", "pixel", "turbo", "hyper", "alpha", "omega",
  "real", "true", "just", "the", "mr", "ms", "big", "lil",
  "mad", "old", "new", "top", "hot", "ice", "red", "blue",
  "max", "dj", "mc", "sir", "doc", "ace", "zen", "raw",
  "odd", "sly", "wiz", "fly", "low", "high", "deep", "pure",
];

const NICK_SUFFIXES = [
  "dragon", "wolf", "fox", "hawk", "storm", "blade", "fire", "ice",
  "shadow", "ghost", "ninja", "ranger", "hunter", "rider", "master",
  "gamer", "coder", "maker", "builder", "runner", "player", "seeker",
  "knight", "king", "queen", "lord", "chief", "boss", "hero", "saint",
  "rebel", "rogue", "scout", "sniper", "tank", "healer", "mage", "monk",
  "bard", "thief",
];

/**
 * Professions and adjectives for email patterns.
 */
const PROFESSIONS = [
  "dev", "eng", "tech", "design", "art", "photo", "music", "writer",
  "chef", "doc", "prof", "coach", "pilot", "trader", "analyst",
  "nurse", "lawyer", "agent", "admin", "editor", "tutor", "baker",
  "driver", "guard", "clerk", "scout", "medic", "smith", "mason", "cook",
];

const ADJECTIVES = [
  "happy", "lucky", "sunny", "brave", "swift", "clever", "bright", "calm",
  "cool", "eager", "fair", "gentle", "honest", "jolly", "keen", "lively",
  "merry", "neat", "polite", "proud", "quiet", "sharp", "smart", "steady",
  "tender", "vivid", "warm", "witty", "bold", "crisp", "deft", "epic",
  "fancy", "grand", "hardy", "ideal", "jazzy", "kind", "lean", "noble",
  "prime", "rapid", "royal", "sleek", "tough", "ultra", "vital", "wild",
  "young", "zesty", "agile", "blunt", "clear", "dense", "exact", "fresh",
  "great", "harsh", "inner", "joint",
];

/**
 * Generate a human-like email prefix with 5B+ possible combinations.
 *
 * v9.0: 500 first names × 300 last names × 17 weighted patterns.
 * Key high-volume patterns:
 *   - fn.ln+num4:     500 × 300 × 9999 = 1.5B
 *   - initial+ln+num4: 500 × 300 × 9999 = 1.5B
 *   - fn.ln+num3:     500 × 300 × 999 = 149.9M
 *   - fn_ln+num3:     500 × 300 × 999 = 149.9M
 *   - initial+ln+num3: 500 × 300 × 999 = 149.9M
 *   - fn.ln+num2:     500 × 300 × 99 = 14.9M
 *   + 11 more patterns
 *   TOTAL: ~5B combinations
 */
export function generateEmailPrefix(_length = 10): string {
  const fn = EMAIL_FIRST_NAMES[Math.floor(Math.random() * EMAIL_FIRST_NAMES.length)];
  const ln = EMAIL_LAST_NAMES[Math.floor(Math.random() * EMAIL_LAST_NAMES.length)];
  const num4 = Math.floor(Math.random() * 9999) + 1;
  const num3 = Math.floor(Math.random() * 999) + 1;
  const num2 = Math.floor(Math.random() * 99) + 1;
  const year = Math.floor(Math.random() * 10) + 2016;

  const roll = Math.random();

  // High-volume patterns (fn.ln+num4 and initial+ln+num4 = 3B alone)
  if (roll < 0.18) {
    return `${fn}.${ln}${num4}`;                                       // john.smith4521
  } else if (roll < 0.36) {
    return `${fn[0]}${ln}${num4}`;                                     // jsmith4521
  } else if (roll < 0.46) {
    return `${fn}.${ln}${num3}`;                                       // john.smith789
  } else if (roll < 0.54) {
    return `${fn}_${ln}${num3}`;                                       // john_smith789
  } else if (roll < 0.62) {
    return `${fn[0]}${ln}${num3}`;                                     // jsmith789
  } else if (roll < 0.68) {
    return `${fn}.${ln}${num2}`;                                       // john.smith42
  } else if (roll < 0.73) {
    return `${fn}_${ln}${num2}`;                                       // john_smith42
  } else if (roll < 0.78) {
    return `${fn}${num4}`;                                             // sarah4521
  } else if (roll < 0.82) {
    return `${fn}.${ln}`;                                              // john.smith
  } else if (roll < 0.85) {
    return `${fn}_${ln}`;                                              // john_smith
  } else if (roll < 0.88) {
    const np = NICK_PREFIXES[Math.floor(Math.random() * NICK_PREFIXES.length)];
    const ns = NICK_SUFFIXES[Math.floor(Math.random() * NICK_SUFFIXES.length)];
    return `${np}${ns}${num3}`;                                        // cooldragon789
  } else if (roll < 0.90) {
    return `${fn}${year}`;                                             // sarah2024
  } else if (roll < 0.92) {
    return `${fn[0]}.${ln}${num2}`;                                    // j.smith42
  } else if (roll < 0.94) {
    const prof = PROFESSIONS[Math.floor(Math.random() * PROFESSIONS.length)];
    return `${prof}.${fn}${num2}`;                                     // dev.sarah42
  } else if (roll < 0.96) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    return `${adj}${fn}${num2}`;                                       // happysarah42
  } else if (roll < 0.98) {
    return `${fn}${num3}`;                                             // sarah789
  } else {
    return `${fn[0]}.${ln}`;                                           // j.smith
  }
}

// ============================================================
// INVITE CODE EXTRACTOR
// ============================================================

export function extractInviteCode(input: string): string {
  if (!input) return "";
  const trimmed = input.trim();

  const pathMatch = trimmed.match(/\/invitation\/([A-Za-z0-9]+)/);
  if (pathMatch) return pathMatch[1];

  const queryMatch = trimmed.match(/[?&]code=([A-Za-z0-9]+)/);
  if (queryMatch) return queryMatch[1];

  if (/^[A-Za-z0-9]+$/.test(trimmed)) return trimmed;

  return trimmed;
}

// ============================================================
// DCR ENCODER
// ============================================================

export function encodeDCR(jsonString: string): string {
  const base64 = Buffer.from(jsonString).toString("base64");
  let encoded = "";
  for (let i = 0; i < base64.length; i++) {
    const c = base64.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      encoded += String.fromCharCode(((c - 65 + 3) % 26) + 65);
    } else if (c >= 97 && c <= 122) {
      encoded += String.fromCharCode(((c - 97 + 3) % 26) + 97);
    } else if (c >= 48 && c <= 57) {
      encoded += String.fromCharCode(((c - 48 + 3) % 10) + 48);
    } else {
      encoded += base64[i];
    }
  }
  return encoded;
}

// ============================================================
// LOGGER
// ============================================================

export const logger = {
  async info(source: string, message: string, details: Record<string, unknown> = {}, jobId?: number) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [INFO] [${source}] ${message}`);
    await _saveLog("info", source, message, details, jobId);
  },
  async warn(source: string, message: string, details: Record<string, unknown> = {}, jobId?: number) {
    const ts = new Date().toISOString();
    console.warn(`[${ts}] [WARN] [${source}] ${message}`);
    await _saveLog("warn", source, message, details, jobId);
  },
  async error(source: string, message: string, details: Record<string, unknown> = {}, jobId?: number) {
    const ts = new Date().toISOString();
    console.error(`[${ts}] [ERROR] [${source}] ${message}`);
    await _saveLog("error", source, message, details, jobId);
  },
};

async function _saveLog(
  level: "info" | "warn" | "error" | "debug",
  source: string,
  message: string,
  details: Record<string, unknown>,
  jobId?: number
) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(logs).values({
      level,
      source,
      message: message.substring(0, 500),
      details,
      jobId: jobId || null,
    });
  } catch (_) {
    // Silently fail - don't break the flow for logging
  }
}
