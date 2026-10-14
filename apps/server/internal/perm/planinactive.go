package perm

// PlanInactiveDenied are the bits the restricted mode («тариф не активен», ADR-0086 amendment)
// takes from everyone in a workspace, the owner and ADMINISTRATOR included: writing and
// attaching (messages, reactions, threads), screen share and camera (voice is audio only),
// inviting members and guests, new temporary rooms, phone calls, new tasks and boards. The
// rights to clean up (MANAGE_*), read, connect and speak stay. TS: PLAN_INACTIVE_DENIED.
const PlanInactiveDenied = SendMessages | AttachFiles | Stream | Video | InviteMembers | InviteGuests |
	CreateTempRooms | PlaceCalls | CreateTasks | CreateBoards

// PlanInactive is the one restricted-mode rule over computed room / board / workspace bits (TS:
// planInactivePermissions; vectors "planInactive" in proto/testdata/permissions.json). The server
// enforces the mode by its route table (app.planInactiveRoutes) and the voice grants (rtc); the
// client hides and disables by this function.
func PlanInactive(b Bits) Bits { return b &^ PlanInactiveDenied }
