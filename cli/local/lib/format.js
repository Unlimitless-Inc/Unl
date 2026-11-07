"use strict";
/*
 * The kept-decision format, version 1, as this implementation reads and writes it.
 *
 * The format is specified in decision-format/README.md and this file follows that document, not the
 * other way round: the address of a decision is computed over its kernel (the decision, its reason,
 * who decided and when) and never over its lifecycle (whether it is still current, what replaced it).
 * So a decision keeps its address for life, and anyone holding a record can recompute the address
 * and know the kernel is what was settled.
 *
 * THE ONE FIXED RULE lives here too: a record whose status is canonical must name the person who
 * made it so, and that name must not be the model that proposed it. Everything else in this
 * package may let agents propose. Nothing in it lets an agent decide.
 */
const { createHash } = require("crypto");

/** Sorted-key JSON with no whitespace. The kernel holds only strings, arrays, objects and null. */
function canonicalJson(value) {
  const walk = (v) => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

function kernelOf(record) {
  const r = record.ruling, w = record.why, p = record.provenance;
  return {
    ruling: { id: r.id, title: r.title, statement: r.statement, authority_scope: r.authority_scope },
    why: { overall_why: w.overall_why, derivation_shape: w.derivation_shape, pillars: (w.pillars || []).map((x) => ({ type: x.type, statement: x.statement })) },
    provenance: {
      wasGeneratedBy: p.wasGeneratedBy, wasDerivedFrom: p.wasDerivedFrom, ratifiedBy: p.ratifiedBy,
      ratifiedAt: p.ratifiedAt, proposerModel: p.proposerModel, proposedAt: p.proposedAt,
    },
  };
}

function decisionId(record) {
  return "walk1:sha256:" + createHash("sha256").update("walk\u0000" + canonicalJson(kernelOf(record)), "utf8").digest("hex");
}

/** A proposal is addressed by its trimmed content and reason, so proposing the same thing twice is one proposal. */
function proposalId(content, why) {
  const body = JSON.stringify({ content: String(content).trim(), why: String(why == null ? "" : why).trim() });
  return "cand1:sha256:" + createHash("sha256").update("candidate " + body, "utf8").digest("hex");
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SCHEMA = require("./decision.schema.json");

/** Build a complete record from its fields, fill the lifecycle defaults, compute the address, and refuse an invalid one. */
function writeDecision({ ruling, why, provenance }) {
  const record = {
    ruling: { status: "canonical", ...ruling },
    why: { derivation_shape: null, pillars: [], ...why },
    provenance: { wasGeneratedBy: null, wasDerivedFrom: [], proposerModel: null, proposedAt: null, wasRevisionOfAll: [], ...provenance },
  };
  if (record.provenance.ratifiedAt instanceof Date) record.provenance.ratifiedAt = record.provenance.ratifiedAt.toISOString();
  const out = { id: decisionId(record), ...record };
  const { ok, errors } = readDecision(out);
  if (!ok) throw new Error("not a valid decision: " + errors.join("; "));
  return out;
}

/** Check a record's shape, the fixed rule, and that its address recomputes. Returns { ok, errors, record }. */
function readDecision(record) {
  const errors = [];
  validate(record, SCHEMA.$defs.Decision, "$", errors);
  if (errors.length === 0) {
    const p = record.provenance;
    if (record.ruling.status === "canonical" && !(typeof p.ratifiedBy === "string" && p.ratifiedBy.trim())) errors.push("$.provenance.ratifiedBy: a canonical decision must name the person who made it canon");
    if (p.ratifiedBy != null && p.proposerModel != null && p.ratifiedBy === p.proposerModel) errors.push("$.provenance.ratifiedBy: the model that proposed it cannot be the one that made it canon");
    if (typeof p.ratifiedAt === "string" && !ISO_UTC.test(p.ratifiedAt)) errors.push("$.provenance.ratifiedAt: expected ISO 8601 UTC with milliseconds, e.g. 2026-07-27T10:38:32.815Z");
    const expected = decisionId(record);
    if (record.id !== expected) errors.push(`$.id: does not recompute from the record (expected ${expected})`);
  }
  return { ok: errors.length === 0, errors, record };
}

// The subset of JSON Schema 2020-12 that decision.schema.json uses. The schema file beside this one is
// a byte-for-byte copy of the published one, and the test suite fails if the two ever differ.
function validate(v, s, at, errors) {
  if (s.$ref) return validate(v, SCHEMA.$defs[s.$ref.split("/").pop()], at, errors);
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const actual = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
      errors.push(`${at}: expected ${types.join(" or ")}, got ${actual}`);
      return;
    }
  }
  if (s.enum && !s.enum.includes(v)) errors.push(`${at}: must be one of ${s.enum.join(", ")}`);
  if (s.pattern && typeof v === "string" && !new RegExp(s.pattern).test(v)) errors.push(`${at}: does not match ${s.pattern}`);
  if (s.items && Array.isArray(v)) v.forEach((x, i) => validate(x, s.items, `${at}[${i}]`, errors));
  if (s.properties && v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of s.required || []) if (!(k in v)) errors.push(`${at}.${k}: required`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties[k]) validate(x, s.properties[k], `${at}.${k}`, errors);
      else if (s.additionalProperties === false) errors.push(`${at}.${k}: not part of the format`);
    }
  }
}

/** The first twelve hex characters of an address: what a person sees and types. */
const shortId = (id) => String(id || "").replace(/^(walk1|cand1):sha256:/, "").slice(0, 12);

module.exports = { canonicalJson, kernelOf, decisionId, proposalId, writeDecision, readDecision, shortId, ISO_UTC };
