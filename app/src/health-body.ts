// Body of the health endpoint. The one-lane deploy answers exactly "ok" (as before). A two-lane deploy appends the state
// of each lane, so an operator can see that lane 2 is disabled while the status stays 200 (lane 1 keeps serving).
export type LaneHealth = "up" | "disabled";
export function healthBody(lanes: readonly { id: string; status: LaneHealth }[] | null): string {
  if (!lanes || lanes.length < 2) return "ok";
  return `ok lanes=${lanes.map((l) => `${l.id}:${l.status}`).join(",")}`;
}
