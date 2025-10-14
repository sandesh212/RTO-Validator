// server/index.js
import express from "express";
import cors from "cors";
import axios from "axios";
import { load } from "cheerio";
import fileUpload from "express-fileupload";
import mammoth from "mammoth";

const app = express();
const PORT = process.env.PORT || 5050;

/* ---------------------------- middleware ---------------------------- */
// IMPORTANT: order matters
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "15mb" }));
app.use(
  fileUpload({
    limits: { fileSize: 25 * 1024 * 1024 },
    // no useTempFiles: we read from buffer via mammoth
  })
);

/* ------------------------------ helpers ----------------------------- */
// Find likely UoC codes in free text (e.g., MARN008, MARH013, HLTAID011, BSBOPS201)
const UOC_CANDIDATE_REGEX = /\b([A-Z]{3,10}[A-Z]*\d{2,4})\b/g;
const BLACKLIST = new Set(["PDF2023", "DOCX2021", "COVID19", "ABN2021", "ISO9001"]);

function findUocCandidates(text) {
  const hits = new Set();
  if (!text) return [];
  for (const m of text.toUpperCase().matchAll(UOC_CANDIDATE_REGEX)) {
    const code = m[1];
    if (!BLACKLIST.has(code) && /[A-Z]/.test(code) && /\d/.test(code)) hits.add(code);
  }
  return Array.from(hits);
}

/* ------------------------------ caching ----------------------------- */
const cache = new Map(); // code -> payload used by UI

/* --------------------------- mock fallbacks -------------------------- */
/** 
 * Used when TGA is unavailable (e.g., 404s today).
 * Add/adjust as needed. These are plausible examples to exercise your UI.
 */
const MOCKS = {
  MARN008: {
    unit: { code: "MARN008", title: "Apply seamanship skills aboard a vessel up to 12 metres (Mock)" },
    elementsAndPC: [
      { pcCode: "1.1", description: "Maintain safe deck practices and housekeeping." },
      { pcCode: "1.2", description: "Perform mooring and anchoring operations." },
      { pcCode: "2.1", description: "Handle lines, ropes and knots for small vessel operations." }
    ],
    knowledgeEvidence: [
      "Basic seamanship terminology and safety practices.",
      "Characteristics and safe use of common knots and splices.",
      "Hazards associated with lines under load and snap-back zones."
    ],
  },
  MARJ006: {
    unit: { code: "MARJ006", title: "Follow environmental work practices (Mock)" },
    elementsAndPC: [
      { pcCode: "1.1", description: "Identify environmental requirements in the work area." },
      { pcCode: "1.2", description: "Handle waste, spills and emissions correctly." }
    ],
    knowledgeEvidence: [
      "Company procedures for waste segregation and disposal.",
      "Reporting requirements for environmental incidents."
    ],
  },
  MARK007: {
    unit: { code: "MARK007", title: "Handle a vessel up to 24 metres (Mock)" },
    elementsAndPC: [
      { pcCode: "1.1", description: "Plan and conduct basic manoeuvres considering wind and tide." },
      { pcCode: "1.2", description: "Use helm and engine controls to maintain course and speed." }
    ],
    knowledgeEvidence: [
      "Effects of wind, tide and current on vessel handling.",
      "Use of propulsion and rudder to pivot and stop a vessel."
    ],
  },
  MARC037: {
    unit: { code: "MARC037", title: "Operate deck machinery (Mock)" },
    elementsAndPC: [
      { pcCode: "1.1", description: "Prepare, operate and secure windlass and capstan safely." },
      { pcCode: "1.2", description: "Communicate effectively during lifting operations." }
    ],
    knowledgeEvidence: [
      "Safe working loads and risk controls for deck machinery.",
      "Lock-out/tag-out procedures."
    ],
  },
  MARI003: {
    unit: { code: "MARI003", title: "Comply with regulations to ensure safe operation (Mock)" },
    elementsAndPC: [
      { pcCode: "1.1", description: "Identify applicable maritime regulations and codes." },
      { pcCode: "1.2", description: "Apply organisational procedures to maintain compliance." }
    ],
    knowledgeEvidence: [
      "Key provisions of local marine safety legislation.",
      "Recordkeeping and reporting obligations."
    ],
  },
};

/* ------------- scrape/parse from training.gov.au (when up) ---------- */
async function fetchFromTGA(code) {
  const url = `https://training.gov.au/Training/Details/${encodeURIComponent(code)}`;

  const { data: html, status } = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "Accept-Language": "en-AU,en;q=0.9",
    },
    timeout: 15000,
    validateStatus: () => true, // we’ll handle non-200s
  });

  if (status !== 200) {
    const err = new Error(`TGA returned ${status}`);
    err.status = status;
    throw err;
  }

  const $ = load(html);
  const h1 = $("h1").first().text().trim();
  if (!h1) throw new Error("No title on page (unexpected TGA markup)");

  // Try to pull out “Elements and Performance Criteria” rows (best-effort).
  // The TGA site markup can change; this is a heuristic. If it fails, the client will still work.
  const elementsAndPC = [];
  const pcSection = $("h2,h3")
    .filter((i, el) => /elements.*performance criteria/i.test($(el).text()))
    .first()
    .parent();
  pcSection.find("tr").each((_, tr) => {
    const cols = $(tr).find("td");
    if (cols.length >= 2) {
      const pcCode = $(cols[0]).text().trim();
      const description = $(cols[1]).text().trim();
      if (pcCode && description) elementsAndPC.push({ pcCode, description });
    }
  });

  // Try to pull out “Knowledge Evidence” bullet points (best-effort).
  const knowledgeEvidence = [];
  const keHeader = $("h2,h3")
    .filter((i, el) => /knowledge evidence/i.test($(el).text()))
    .first();
  keHeader.nextAll("ul").first().find("li").each((_, li) => {
    const t = $(li).text().trim();
    if (t) knowledgeEvidence.push(t);
  });

  return {
    unit: { code, title: h1 },
    url,
    elementsAndPC,
    knowledgeEvidence,
    source: "tga",
  };
}

/* -------------------- unified TGA + fallback fetcher ------------------ */
async function getUocPayload(codeRaw) {
  const code = String(codeRaw || "").toUpperCase();
  if (!code) throw new Error("No code");

  // cache first
  if (cache.has(code)) return cache.get(code);

  // try TGA
  try {
    const live = await fetchFromTGA(code);
    cache.set(code, live);
    return live;
  } catch (err) {
    // fallback to mock (for testing while TGA is down)
    const mock = MOCKS[code] || {
      unit: { code, title: `${code} (Mock Unit for testing)` },
      elementsAndPC: [
        { pcCode: "1.1", description: "Example performance criterion." },
        { pcCode: "1.2", description: "Another performance criterion." },
      ],
      knowledgeEvidence: ["Example knowledge item A.", "Example knowledge item B."],
    };
    const payload = { ...mock, url: `https://training.gov.au/Training/Details/${code}`, source: "mock" };
    cache.set(code, payload);
    return payload;
  }
}

/* -------------------------------- routes ------------------------------ */

// health
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "rto-validator-api", port: PORT });
});

// look up a single code -> returns shape that the client expects
app.get("/api/uoc/:code", async (req, res) => {
  try {
    const payload = await getUocPayload(req.params.code);
    res.json(payload);
  } catch (e) {
    res.status(404).json({ found: false, code: req.params.code, error: e.message || "Not found" });
  }
});

// upload a .docx/.txt, extract text, detect codes
app.post("/api/extract", async (req, res) => {
  try {
    if (!req.files || !req.files.assessment) {
      return res.status(400).json({ error: "No file uploaded (field name must be 'assessment')." });
    }

    const file = req.files.assessment;
    const ct = file.mimetype || "";
    let text = "";

    if (
      ct.includes("vnd.openxmlformats-officedocument.wordprocessingml.document") ||
      file.name.toLowerCase().endsWith(".docx")
    ) {
      const { value } = await mammoth.extractRawText({ buffer: file.data });
      text = value || "";
    } else if (ct.includes("text/plain") || file.name.toLowerCase().endsWith(".txt")) {
      text = file.data.toString("utf8");
    } else {
      return res.status(400).json({ error: `Unsupported file type: ${ct || file.name}` });
    }

    const detected = findUocCandidates(text);
    res.json({ text, detected });
  } catch (e) {
    console.error("extract failed:", e);
    res.status(500).json({ error: "Failed to process file" });
  }
});

// quick alias (old client code compatibility)
app.post("/api/auto-detect", (req, res, next) => {
  req.url = "/api/extract";
  next();
});

/* ------------------------------- start ------------------------------- */
app.listen(PORT, () => {
  console.log(`API ready on http://localhost:${PORT}`);
});
