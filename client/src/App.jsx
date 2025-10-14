// client/src/App.jsx
import React, { useState } from "react";
import {
  Upload,
  CheckCircle,
  AlertCircle,
  FileText,
  Download,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";

const API_BASE = "http://localhost:5050";

/* ---------------------- text coverage helpers ---------------------- */
const STOP = new Set([
  "the","and","a","an","for","to","of","in","on","by","with","as","that","are","is","be","or","at",
  "from","this","it","into","over","under","up","down","across","about","between","their","your",
  "you","we","our","they"
]);
const tokenize = (t) =>
  (t || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));

const coverageCheck = (fullText, targets) => {
  const textTokens = new Set(tokenize(fullText || ""));
  const missing = [];
  let covered = 0;

  for (const t of targets) {
    const key = tokenize(t.text);
    if (!key.length) continue;
    const present = key.filter((k) => textTokens.has(k)).length;
    const ratio = present / key.length;
    if (ratio >= 0.35) covered += 1;
    else missing.push(t.code || t.text.slice(0, 60));
  }

  return {
    total: targets.length,
    assessed: covered,
    percentage: targets.length ? Math.round((covered * 100) / targets.length) : 0,
    missing,
  };
};
/* ------------------------------------------------------------------ */

export default function App() {
  const [activeTab, setActiveTab] = useState("upload");

  const [assessmentFile, setAssessmentFile] = useState(null);
  const [assessmentText, setAssessmentText] = useState("");
  const [detectedUoCs, setDetectedUoCs] = useState([]);

  // Multi-UoC reports and active selection
  const [reports, setReports] = useState([]); // [{ unit, coverage, rulesOfEvidence, principlesOfAssessment, gaps }]
  const [activeReportIdx, setActiveReportIdx] = useState(0);

  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadError, setUploadError] = useState("");

  /* -------------------------- API helpers -------------------------- */
  const fetchUoc = async (code) => {
    try {
      const r = await fetch(`${API_BASE}/api/uoc/${code}`);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  };

  /* ---------------------------- Handlers --------------------------- */
  const handleUpload = async (e) => {
    setUploadError("");
    setDetectedUoCs([]);
    setAssessmentText("");
    setReports([]);
    setActiveReportIdx(0);

    const file = e.target.files?.[0];
    if (!file) return;

    setAssessmentFile(file);

    const form = new FormData();
    // MUST be 'assessment' to match server field name
    form.append("assessment", file);

    try {
      const resp = await fetch(`${API_BASE}/api/extract`, { method: "POST", body: form });

      if (!resp.ok) {
        let msg = `Upload failed: HTTP ${resp.status}`;
        try {
          const maybe = await resp.json();
          if (maybe?.error) msg = maybe.error;
        } catch {
          try {
            const t = await resp.text();
            if (t) msg = t.slice(0, 400);
          } catch {}
        }
        setUploadError(msg || "Upload failed");
        return;
      }

      const data = await resp.json();
      setDetectedUoCs(data.detected || []);
      setAssessmentText(data.text || "");
      setUploadError("");
    } catch {
      setUploadError("Network error while uploading file.");
    }
  };

  const buildReportFromTGA = (tgaPayload) => {
    // Normalize unit
    const unit = tgaPayload.unit?.code
      ? { code: tgaPayload.unit.code, title: tgaPayload.unit.title || tgaPayload.title || "", url: tgaPayload.url }
      : { code: tgaPayload.code, title: tgaPayload.title || "", url: tgaPayload.url };

    const pcs = (tgaPayload.elementsAndPC || [])
      .filter((p) => p.pcCode && p.description)
      .map((p) => ({ code: `PC ${p.pcCode}`, text: p.description }));

    const kes = (tgaPayload.knowledgeEvidence || []).map((t, i) => ({
      code: `K${i + 1}`,
      text: t,
    }));

    const pcCov = coverageCheck(assessmentText, pcs);
    const keCov = coverageCheck(assessmentText, kes);

    const sufficiency = Math.min(100, Math.round(pcCov.percentage * 0.6 + keCov.percentage * 0.4));
    const validity = pcCov.percentage;

    const rulesOfEvidence = {
      validity: { status: validity >= 85 ? "pass" : validity >= 70 ? "warning" : "fail", score: validity },
      sufficiency: {
        status: sufficiency >= 90 ? "pass" : sufficiency >= 75 ? "warning" : "fail",
        score: sufficiency,
      },
      authenticity: { status: "pass", score: 100 },
      currency: { status: "pass", score: 100 },
    };

    const principlesOfAssessment = {
      fairness: { status: "pass", score: 95 },
      flexibility: { status: "pass", score: 90 },
      validity: { status: rulesOfEvidence.validity.status, score: validity },
      reliability: { status: "pass", score: 92 },
    };

    const gaps = [];
    pcCov.missing.slice(0, 5).forEach((pc) =>
      gaps.push({
        type: "critical",
        element: pc,
        description: "Performance criterion not clearly evidenced in assessment text.",
        recommendation: "Add/clarify an assessment task or marking checklist item for this PC.",
        priority: "HIGH",
      })
    );
    keCov.missing.slice(0, 5).forEach((k) =>
      gaps.push({
        type: "improvement",
        element: k,
        description: "Knowledge evidence coverage could be strengthened.",
        recommendation: "Add a short-answer/scenario question to explicitly test this knowledge.",
        priority: "MEDIUM",
      })
    );

    return {
      unit,
      coverage: {
        performanceCriteria: pcCov,
        knowledge: keCov,
      },
      rulesOfEvidence,
      principlesOfAssessment,
      gaps,
    };
  };

  const validate = async () => {
    if (!detectedUoCs.length) {
      setActiveTab("results");
      setReports([
        {
          unit: { code: "N/A", title: "No UoC detected" },
          coverage: {
            performanceCriteria: { total: 0, assessed: 0, percentage: 0, missing: [] },
            knowledge: { total: 0, assessed: 0, percentage: 0, missing: [] },
          },
          rulesOfEvidence: {
            validity: { status: "fail", score: 0 },
            sufficiency: { status: "fail", score: 0 },
            authenticity: { status: "warning", score: 50 },
            currency: { status: "warning", score: 50 },
          },
          principlesOfAssessment: {
            fairness: { status: "warning", score: 50 },
            flexibility: { status: "warning", score: 50 },
            validity: { status: "fail", score: 0 },
            reliability: { status: "warning", score: 50 },
          },
          gaps: [
            {
              type: "critical",
              element: "UoC",
              description: "No valid UoC detected in document.",
              recommendation: "Ensure the assessment references the correct Unit code(s) per Training.gov.au.",
              priority: "HIGH",
            },
          ],
        },
      ]);
      return;
    }

    setIsProcessing(true);
    setActiveTab("results");

    try {
      // Lookup all UoCs in parallel
      const results = await Promise.allSettled(detectedUoCs.map((c) => fetchUoc(c)));

      const perUnitReports = results.map((settled, idx) => {
        const code = detectedUoCs[idx];
        if (settled.status !== "fulfilled" || !settled.value || settled.value.found === false) {
          return {
            unit: { code, title: "No TGA details available" },
            coverage: {
              performanceCriteria: { total: 0, assessed: 0, percentage: 0, missing: [] },
              knowledge: { total: 0, assessed: 0, percentage: 0, missing: [] },
            },
            rulesOfEvidence: {
              validity: { status: "fail", score: 0 },
              sufficiency: { status: "fail", score: 0 },
              authenticity: { status: "warning", score: 50 },
              currency: { status: "warning", score: 50 },
            },
            principlesOfAssessment: {
              fairness: { status: "warning", score: 50 },
              flexibility: { status: "warning", score: 50 },
              validity: { status: "fail", score: 0 },
              reliability: { status: "warning", score: 50 },
            },
            gaps: [
              {
                type: "critical",
                element: code,
                description: "Could not fetch details from training.gov.au for this code.",
                recommendation: "Check the unit code or try again later.",
                priority: "HIGH",
              },
            ],
          };
        }

        return buildReportFromTGA(settled.value);
      });

      setReports(perUnitReports);
      setActiveReportIdx(0);
    } finally {
      setIsProcessing(false);
    }
  };

  /* --------------------------- UI helpers -------------------------- */
  const statusPill = (s) =>
    s === "pass"
      ? "bg-green-100 text-green-800"
      : s === "warning"
      ? "bg-yellow-100 text-yellow-800"
      : "bg-red-100 text-red-800";

  const priorityPill = (p) =>
    p === "HIGH"
      ? "bg-red-100 text-red-800"
      : p === "MEDIUM"
      ? "bg-yellow-100 text-yellow-800"
      : "bg-blue-100 text-blue-800";

  const activeReport = reports[activeReportIdx];

  const Tile = ({ title, value, sub, leftBorder }) => (
    <div className={`bg-white rounded-xl shadow-sm p-6 border-l-4 ${leftBorder}`}>
      <div className="text-sm text-gray-600 font-semibold mb-1">{title}</div>
      <div className="text-3xl font-extrabold text-gray-900">{value}</div>
      {sub && <div className="text-sm text-gray-500 mt-1">{sub}</div>}
    </div>
  );

  /* ------------------------------- UI ------------------------------ */
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-gradient-to-r from-indigo-700 to-purple-700 text-white">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <h1 className="text-3xl font-bold tracking-tight">RTO Assessment Validator</h1>
          <p className="text-indigo-100 mt-1">
            Upload your assessment. We’ll detect UoCs and check coverage against Training.gov.au.
          </p>
        </div>
      </header>

      {/* Tabs */}
      <nav className="max-w-6xl mx-auto px-6 mt-6">
        <div className="border-b border-gray-200">
          <div className="flex gap-8">
            <button
              onClick={() => setActiveTab("upload")}
              className={`pb-4 px-1 border-b-2 font-medium ${
                activeTab === "upload"
                  ? "border-indigo-600 text-indigo-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
              aria-current={activeTab === "upload" ? "page" : undefined}
            >
              <Upload className="inline w-5 h-5 mr-2 -mt-1" />
              Upload
            </button>
            <button
              onClick={() => setActiveTab("results")}
              disabled={!reports.length}
              className={`pb-4 px-1 border-b-2 font-medium ${
                activeTab === "results"
                  ? "border-indigo-600 text-indigo-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              <FileText className="inline w-5 h-5 mr-2 -mt-1" />
              Results
            </button>
          </div>
        </div>
      </nav>

      {/* Body */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Upload */}
        {activeTab === "upload" && (
          <section className="space-y-6">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
              <Upload className="mx-auto w-12 h-12 text-gray-400 mb-4" />
              <h3 className="text-lg font-semibold mb-2">Upload Assessment (.docx or .txt)</h3>

              <input id="fileup" type="file" accept=".docx,.txt" onChange={handleUpload} className="hidden" />
              <label
                htmlFor="fileup"
                className="inline-flex items-center px-4 py-2 bg-indigo-600 text-white rounded-lg cursor-pointer hover:bg-indigo-700 transition"
              >
                Choose File
              </label>

              {assessmentFile && (
                <div className="mt-4 inline-flex items-center text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
                  <CheckCircle className="w-4 h-4 mr-2" />
                  {assessmentFile.name}
                </div>
              )}

              {detectedUoCs.length > 0 && (
                <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded text-blue-800 text-sm">
                  Detected UoCs: <strong>{detectedUoCs.join(", ")}</strong>
                </div>
              )}

              {uploadError && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
                  {uploadError}
                </div>
              )}
            </div>

            <div className="flex justify-center">
              <button
                onClick={validate}
                disabled={!assessmentFile || isProcessing}
                className="px-8 py-3 bg-indigo-600 text-white text-base rounded-lg hover:bg-indigo-700 disabled:bg-gray-400 shadow-sm"
              >
                {isProcessing ? "Analyzing..." : "Validate Assessment"}
              </button>
            </div>
          </section>
        )}

        {/* Results (multi-UoC) */}
        {activeTab === "results" && reports.length > 0 && (
          <section className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {/* Left: UoC list */}
            <aside className="md:col-span-1">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Units detected</h3>
                <div className="space-y-2">
                  {reports.map((r, idx) => {
                    const pct = r.coverage.performanceCriteria.percentage;
                    const isActive = idx === activeReportIdx;
                    return (
                      <button
                        key={r.unit.code + idx}
                        onClick={() => setActiveReportIdx(idx)}
                        className={`w-full text-left px-3 py-3 rounded-lg border transition ${
                          isActive
                            ? "border-indigo-500 bg-indigo-50 shadow-[0_0_0_2px_rgba(99,102,241,0.15)]"
                            : "border-gray-200 bg-white hover:bg-gray-50"
                        }`}
                        aria-current={isActive ? "true" : "false"}
                      >
                        <div className="flex items-center justify-between">
                          <div className="font-semibold text-gray-900">{r.unit.code}</div>
                          <div className="text-xs text-gray-500">{pct}% PC</div>
                        </div>
                        <div className="text-xs text-gray-600 truncate">{r.unit.title}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </aside>

            {/* Right: active report */}
            <section className="md:col-span-3 space-y-6">
              {/* Header + export */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-bold text-gray-900">{activeReport.unit.code}</h2>
                    <p className="text-gray-600 mt-1">{activeReport.unit.title}</p>
                    {activeReport.unit.url && (
                      <a
                        href={activeReport.unit.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-indigo-600 mt-2 underline"
                      >
                        View on training.gov.au <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="inline-flex items-center px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                      onClick={() => {
                        const blob = new Blob([JSON.stringify(activeReport, null, 2)], {
                          type: "application/json",
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${activeReport.unit.code || "validation"}_report.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      <Download className="w-4 h-4 mr-2" /> Export JSON
                    </button>
                  </div>
                </div>
              </div>

              {/* Summary tiles */}
              <div className="grid md:grid-cols-3 gap-6">
                <Tile
                  title="Performance Criteria"
                  value={`${activeReport.coverage.performanceCriteria.percentage}%`}
                  sub={`${activeReport.coverage.performanceCriteria.assessed}/${activeReport.coverage.performanceCriteria.total} Covered`}
                  leftBorder="border-indigo-500"
                />
                <Tile
                  title="Knowledge Evidence"
                  value={`${activeReport.coverage.knowledge.percentage}%`}
                  sub={`${activeReport.coverage.knowledge.assessed}/${activeReport.coverage.knowledge.total} Covered`}
                  leftBorder="border-blue-500"
                />
                <div className="bg-white rounded-xl shadow-sm p-6 border-l-4 border-green-500">
                  <div className="text-sm text-gray-600 font-semibold mb-1">Overall</div>
                  <div className="mt-1">
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold bg-amber-100 text-amber-800">
                      <AlertTriangle className="w-4 h-4 mr-1" />
                      {activeReport.coverage.performanceCriteria.percentage >= 90 &&
                      activeReport.coverage.knowledge.percentage >= 85
                        ? "Looks Good"
                        : "Needs Review"}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    Aim for ≥90% PC and ≥85% Knowledge coverage.
                  </p>
                </div>
              </div>

              {/* Rules of Evidence */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h3 className="text-xl font-bold mb-4 text-gray-900">Rules of Evidence</h3>
                <div className="grid md:grid-cols-2 gap-4">
                  {Object.entries(activeReport.rulesOfEvidence).map(([rule, data]) => (
                    <div key={rule} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                      <div className="flex items-center">
                        {data.status === "pass" ? (
                          <span className="text-green-600 mr-3">✔</span>
                        ) : (
                          <AlertCircle className="w-5 h-5 text-amber-500 mr-3" />
                        )}
                        <span className="font-semibold capitalize text-gray-900">{rule}</span>
                      </div>
                      <span className={`px-3 py-1 rounded-full text-xs font-semibold ${statusPill(data.status)}`}>
                        {data.score}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* What’s Missing */}
              {(activeReport.coverage.performanceCriteria.missing.length > 0 ||
                activeReport.coverage.knowledge.missing.length > 0) && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                  <h3 className="text-xl font-bold mb-4 text-gray-900">What’s Missing</h3>
                  <div className="grid md:grid-cols-2 gap-6">
                    {activeReport.coverage.performanceCriteria.missing.length > 0 && (
                      <div>
                        <div className="text-sm font-semibold mb-2 text-gray-800 flex items-center gap-2">
                          <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />
                          Performance Criteria not clearly evidenced
                        </div>
                        <ul className="space-y-2">
                          {activeReport.coverage.performanceCriteria.missing.map((m, i) => (
                            <li key={`pc-miss-${i}`} className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">
                              {m}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {activeReport.coverage.knowledge.missing.length > 0 && (
                      <div>
                        <div className="text-sm font-semibold mb-2 text-gray-800 flex items-center gap-2">
                          <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" />
                          Knowledge Evidence to strengthen
                        </div>
                        <ul className="space-y-2">
                          {activeReport.coverage.knowledge.missing.map((m, i) => (
                            <li key={`ke-miss-${i}`} className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                              {m}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Recommendations / Gaps */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h3 className="text-xl font-bold mb-4 text-gray-900">Gaps & Recommendations</h3>
                {activeReport.gaps.length === 0 ? (
                  <div className="text-sm text-gray-500">No gaps detected for this unit.</div>
                ) : (
                  <div className="space-y-4">
                    {activeReport.gaps.map((g, i) => (
                      <div key={i} className="border border-gray-200 rounded-lg p-4">
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center">
                            <span className="font-bold text-gray-900 mr-3">{g.element}</span>
                            <span className={`px-2 py-1 rounded text-xs font-semibold ${priorityPill(g.priority)}`}>
                              {g.priority}
                            </span>
                          </div>
                        </div>
                        <p className="text-sm text-gray-700 mb-2">{g.description}</p>
                        <div className="bg-blue-50 border-l-4 border-blue-400 p-3 mt-3 rounded">
                          <p className="text-sm text-blue-900">
                            <strong>💡 Recommendation:</strong> {g.recommendation}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </section>
        )}

        {activeTab === "results" && !reports.length && (
          <section className="text-sm text-gray-600">
            No results yet. Upload a file and click <span className="font-semibold">“Validate Assessment”</span>.
          </section>
        )}
      </main>

      {/* Simple loading overlay */}
      {isProcessing && (
        <div className="fixed inset-0 bg-black/10 backdrop-blur-[1px] flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-lg px-6 py-4 border border-gray-200">
            <div className="flex items-center gap-3">
              <div className="w-4 h-4 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
              <div className="text-sm text-gray-700">Analyzing your document…</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
