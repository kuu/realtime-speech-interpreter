// Claude Haiku 4.5 geo inference profiles by stack Region.
// Source: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html
// (section "Geo inference details", read 2026-11-23; the table changes, re-check it before editing).
// The bedrock-runtime endpoint needs a geo or global inference profile; the bare model id is not supported.
// There is no "apac." profile for this model. The "global." profile routes worldwide and is deliberately not
// supported here, because the IAM policy then needs a wildcard Region list and data residency is lost.
export const HAIKU_FOUNDATION_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";

const US = ["us-east-1", "us-east-2", "us-west-2"];
const EU = ["eu-central-1", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-3"];

/** prefix -> source Region -> destination Regions (the order is the order used in the IAM resource list). */
export const GEO_PROFILES: Record<string, Record<string, string[]>> = {
  jp: {
    "ap-northeast-1": ["ap-northeast-1", "ap-northeast-3"],
    "ap-northeast-3": ["ap-northeast-1", "ap-northeast-3"],
  },
  us: {
    "us-east-1": US,
    "us-east-2": US,
    "us-west-1": ["us-east-1", "us-east-2", "us-west-1", "us-west-2"],
    "us-west-2": US,
    "ca-central-1": ["ca-central-1", ...US],
  },
  eu: {
    "eu-central-1": EU,
    "eu-central-2": ["eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-3"],
    "eu-north-1": EU,
    "eu-south-1": EU,
    "eu-south-2": EU,
    "eu-west-1": EU,
    "eu-west-2": ["eu-central-1", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-2", "eu-west-3"],
    "eu-west-3": EU,
  },
  au: {
    "ap-southeast-2": ["ap-southeast-2", "ap-southeast-4"],
    "ap-southeast-4": ["ap-southeast-2", "ap-southeast-4"],
    "ap-southeast-6": ["ap-southeast-2", "ap-southeast-4", "ap-southeast-6"],
  },
  in: {
    "ap-south-1": ["ap-south-1", "ap-south-2"],
    "ap-south-2": ["ap-south-1", "ap-south-2"],
  },
};

/** Regions that have a Claude Haiku 4.5 geo inference profile. */
export function supportedRegions(): string[] {
  return Object.values(GEO_PROFILES).flatMap((m) => Object.keys(m));
}

/** Geo prefix usable from `region`, or undefined. */
export function profilePrefixForRegion(region: string): string | undefined {
  return Object.keys(GEO_PROFILES).find((p) => Object.prototype.hasOwnProperty.call(GEO_PROFILES[p], region));
}

/** Default Haiku 4.5 inference profile id for the Region, or undefined when the Region has no geo profile. */
export function defaultLlmModelId(region: string): string | undefined {
  const p = profilePrefixForRegion(region);
  return p === undefined ? undefined : `${p}.${HAIKU_FOUNDATION_MODEL_ID}`;
}

/** Split "<geo prefix>.<foundation model id>" (known geo prefixes only; "global." and "apac." give undefined). */
export function parseProfile(id: string): { prefix: string; foundationModelId: string } | undefined {
  const m = /^([a-z]+)\.([a-z0-9][a-z0-9.-]*(:\d+)?)$/.exec(id);
  if (!m || !Object.prototype.hasOwnProperty.call(GEO_PROFILES, m[1])) return undefined;
  return { prefix: m[1], foundationModelId: m[2] };
}

/** Destination Regions of the `prefix` profile when called from `region`, or undefined. */
export function destinationRegions(prefix: string, region: string): string[] | undefined {
  const map = GEO_PROFILES[prefix];
  return map && Object.prototype.hasOwnProperty.call(map, region) ? [...map[region]] : undefined;
}
