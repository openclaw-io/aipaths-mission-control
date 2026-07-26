export interface LocalMissionControlUser {
  email: string;
}

export function isLocalAuthDisabled() {
  return process.env.MISSION_CONTROL_LOCAL_AUTH_DISABLED === "true";
}

export function getLocalMissionControlUser(): LocalMissionControlUser | null {
  if (!isLocalAuthDisabled()) return null;
  return { email: "local@mission-control" };
}
