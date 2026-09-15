// Test-only surface. Kept out of the main barrel so importing the package
// never pulls vitest into an app bundle.

export { describeRoomContract } from "./ports/room-contract";
export type { RoomHarness } from "./ports/room-contract";
