// Prints the resolved configuration as JSON for scripts/doctor.sh. Same layers as `cdk synth`.
// Usage: ts-node scripts/resolved-config.ts [-c key=value ...]
import * as cdk from "aws-cdk-lib";
import { loadConfig, resolveRegion } from "../lib/config";
import { buildResolver, cdkJsonContext } from "../lib/event-config";

const overrides: Record<string, string> = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i] === "-c" || args[i] === "--context" ? args[++i] : undefined;
  const m = a ? /^([^=]+)=(.*)$/.exec(a) : null;
  if (m) overrides[m[1]] = m[2];
}
const app = new cdk.App({ context: { ...cdkJsonContext(), ...overrides } });
const out: Record<string, unknown> = { ok: true };
try {
  out.region = resolveRegion(app);
  const r = buildResolver((k) => app.node.tryGetContext(k));
  out.profile = r.profile;
  out.eventFile = r.eventFile;
  const cfg = loadConfig(app);
  Object.assign(out, {
    venueCidrs: cfg.venueCidrs,
    translateEngine: cfg.translateEngine,
    llmModelId: cfg.llmModelId,
    transcribeVocabularyName: cfg.transcribeVocabularyName,
    translateTerminologyName: cfg.translateTerminologyName,
    sourceLanguage: cfg.sourceLanguage,
    dictionaryDir: cfg.dictionaryDir,
    dictionaryDirSource: cfg.dictionaryDirSource,
    inputSource: cfg.inputSource,
    rtmpPort: cfg.rtmpPort,
  });
} catch (err) {
  out.ok = false;
  out.error = (err as Error).message;
}
process.stdout.write(JSON.stringify(out) + "\n");
