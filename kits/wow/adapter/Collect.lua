-- Collection -----------------------------------------------------------------
--
-- A collection reads every part of OpenGamerMCPDB from the client and keeps
-- the values in memory. The table itself is written only at PLAYER_LOGOUT,
-- which fires on logout and on every UI reload, just before the client writes
-- SavedVariables (docs/architecture.md §6.3).

local _, ns = ...

local COLLECT_INTERVAL = ns.COLLECT_INTERVAL
local COLLECT_DEBOUNCE = ns.COLLECT_DEBOUNCE
local QUEST_EVENT_GRACE = ns.QUEST_EVENT_GRACE
local COLLECT_EVENTS = ns.COLLECT_EVENTS
local Now = ns.Now
local MarkItemCacheStale = ns.MarkItemCacheStale
local ItemsPending = ns.ItemsPending
local Write = ns.Write

-- The parts of OpenGamerMCPDB read from the client, in collection order. A
-- part with top set goes to the top level of the table, every other part
-- into state.
local COLLECT_PARTS = {
	{ key = "client", fn = ns.CollectClient, top = true },
	{ key = "character", fn = ns.CollectCharacterKey, top = true },
	{ key = "character", fn = ns.CollectCharacter },
	{ key = "location", fn = ns.CollectLocation },
	{ key = "quests", fn = ns.CollectQuests },
	{ key = "inventory", fn = ns.CollectInventory },
	{ key = "skills", fn = ns.CollectSkills },
}

local collecting = false
local questEventsIgnoredUntil = 0
-- The value of each part from its last successful collection, keyed by part.
local latest = {}

-- Collect reads every part. Each part runs in its own protected call, so one
-- failure leaves the others intact, and a part that fails keeps the value of
-- its last successful collection. A call while a collection is already
-- running does nothing; that can only happen if an API it calls re-enters it
-- through an event.
local function Collect()
	if collecting then
		return
	end
	collecting = true
	-- The quests collector sets selectionChanged when it changed the quest
	-- log selection.
	local status = {}
	for _, part in ipairs(COLLECT_PARTS) do
		local ok, result = pcall(part.fn, status)
		if ok then
			latest[part] = result
		end
	end
	collecting = false

	if status.selectionChanged then
		questEventsIgnoredUntil = Now() + QUEST_EVENT_GRACE
	end
end

-- At PLAYER_LOGOUT every part is collected again, so the state and
-- captured_at match the moment the client writes SavedVariables. Without
-- this, position would lag by up to one collection interval. A part that
-- fails here keeps its last polled value.
local logoutFrame = CreateFrame("Frame")
logoutFrame:RegisterEvent("PLAYER_LOGOUT")
logoutFrame:SetScript("OnEvent", function()
	Collect()
	Write(latest, COLLECT_PARTS)
end)

-- Scheduling -----------------------------------------------------------------
--
-- Events never collect directly. They schedule one collection COLLECT_DEBOUNCE
-- seconds out, and further events before it runs coalesce into it. A 5-second
-- ticker also collects, because position changes fire no event.
--
-- Selecting a quest to read its text may fire QUEST_LOG_UPDATE. Three things
-- stop that from re-triggering collection: events are ignored while a
-- collection runs, QUEST_LOG_UPDATE is ignored for QUEST_EVENT_GRACE seconds
-- after a collection that changed the selection, and cached text means the
-- next collection does not change the selection again. Empty text is retried
-- only on the backoff schedule, at most QUEST_TEXT_MAX_ATTEMPTS times.

local collectorFrame = CreateFrame("Frame")
-- ns.inWorld is true once PLAYER_ENTERING_WORLD has fired.
ns.inWorld = false
local collectScheduled = false
local collectTicker

local function RunScheduledCollection()
	collectScheduled = false
	Collect()
end

local function ScheduleCollection()
	if collectScheduled then
		return
	end
	collectScheduled = true
	C_Timer.After(COLLECT_DEBOUNCE, RunScheduledCollection)
end

local function StartTicker()
	if collectTicker then
		return
	end
	collectTicker = C_Timer.NewTicker(COLLECT_INTERVAL, function()
		Collect()
	end)
end

for _, event in ipairs(COLLECT_EVENTS) do
	pcall(collectorFrame.RegisterEvent, collectorFrame, event)
end

collectorFrame:SetScript("OnEvent", function(_, event)
	if event == "PLAYER_ENTERING_WORLD" then
		ns.inWorld = true
		StartTicker()
	end
	if event == "BAG_UPDATE_DELAYED" or event == "PLAYER_EQUIPMENT_CHANGED" then
		MarkItemCacheStale()
	end
	if not ns.inWorld or collecting then
		return
	end
	if event == "QUEST_LOG_UPDATE" and Now() < questEventsIgnoredUntil then
		return
	end
	ScheduleCollection()
end)

-- GET_ITEM_INFO_RECEIVED fires when the client has cached an item it was asked
-- for, and PLAYER_REGEN_ENABLED when combat ends. Both matter only while an
-- item's details are incomplete. Other addons and the UI ask for items too, so
-- without a waiting entry the events do nothing.
local itemEventFrame = CreateFrame("Frame")
pcall(itemEventFrame.RegisterEvent, itemEventFrame, "GET_ITEM_INFO_RECEIVED")
pcall(itemEventFrame.RegisterEvent, itemEventFrame, "PLAYER_REGEN_ENABLED")
itemEventFrame:SetScript("OnEvent", function()
	if not ns.inWorld or not ItemsPending() then
		return
	end
	MarkItemCacheStale()
	if not collecting then
		ScheduleCollection()
	end
end)

-- Read by the files after this one, and by the tests.
ns.Collect = Collect
