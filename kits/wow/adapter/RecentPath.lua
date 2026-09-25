-- Section: recent_path -------------------------------------------------------
--
-- recent_path is a breadcrumb of where the character has been
-- (docs/architecture.md §6.3): a list of places, oldest first, with at most
-- RECENT_PATH_MAX entries. An entry holds the fields of a place in the
-- prototype's get_recent_path (bttf/wow-guide@df80260:cloud/src/mcpTools.ts,
-- PathEntry) that the client reports, named like the location section:
--
--   captured_at   GetServerTime() at the collection that saw the change
--   map_id        the location section's map_id, nil when unreadable
--   zone          the location section's zone: the name of the zone map that
--                 map_id lies in, else GetRealZoneText()
--   subzone       GetSubZoneText(), "" where the zone has no subzone
--   x, y          the position on map_id, from 0 to 1; nil in an instance
--   in_instance   the first return of IsInInstance()
--
-- Every collection reads the place and appends it when it differs from the
-- newest entry. The map ID decides a zone change when both have one, because
-- GetRealZoneText can briefly name a building while the map ID stays the same
-- (bttf/wow-guide@df80260:addon/Storage.lua, ZoneChanged). For the same
-- reason the zone comes from the zone map where there is one (CollectLocation
-- in Collectors.lua), so there a building name is never the zone, not even in
-- the first entry of a session. The zone text decides only when a map ID is
-- missing, as in an instance. A subzone that differs is a change too. A place
-- with no zone name from either the map or the zone text, as can happen just
-- after a loading screen, is not recorded, and a value that could not be read
-- is never a change. A map ID can arrive before the zone text. That place is
-- recorded with the zone map's name and possibly an empty subzone, and a
-- subzone change less than RECENT_PATH_MIN_INTERVAL seconds later replaces
-- it, as below.
--
-- A subzone change keeps the zone of the newest entry, so a building name
-- read on the same map never becomes the zone. A subzone change less than
-- RECENT_PATH_MIN_INTERVAL seconds after the newest entry replaces that entry,
-- so walking back and forth across a subzone border does not fill the path.
-- When the replacement is the place of the entry before, the short visit is
-- dropped. A zone change always appends.
--
-- recent_path is the one section carried across reloads (§6.3.1). The first
-- collection of a session takes the entries of the OpenGamerMCPDB the client
-- loaded, when that table belongs to the same character. The zone of a
-- carried entry is read again from its map ID, so an entry written while
-- GetRealZoneText named a building takes the name of its zone map. An entry
-- whose map gives no zone name keeps its zone. A client that does not read
-- SavedVariables back, as WoW Forever builds 69893 and 69913 do, leaves
-- OpenGamerMCPDB empty, so there the path starts at the reload. The adapter
-- checks the table, never the client.

local _, ns = ...

-- Most entries kept (proposed). The prototype's get_recent_path listed at
-- most 20 places (bttf/wow-guide@df80260:cloud/src/mcpTools.ts,
-- MAX_PATH_ENTRIES).
local RECENT_PATH_MAX = 20
-- Seconds after the newest entry during which a subzone change replaces it
-- (proposed). The prototype's PUSH_MIN_INTERVAL
-- (bttf/wow-guide@df80260:addon/Storage.lua).
local RECENT_PATH_MIN_INTERVAL = 30

local PlainField = ns.PlainField
local ReadString = ns.ReadString
local ReadName = ns.ReadName
local ReadNumber = ns.ReadNumber
local ReadInteger = ns.ReadInteger
local ReadBoolean = ns.ReadBoolean
local ReadTable = ns.ReadTable
local Api = ns.Api
local ZoneName = ns.ZoneName
local CollectLocation = ns.CollectLocation

-- The entries, oldest first. nil until the first collection of the session.
local path

-- ReadEntry returns a path entry built from the fields of t, or nil when its
-- time or zone is unreadable. A secret field reads as nil.
local function ReadEntry(t)
	local capturedAt = ReadInteger(PlainField(t, "captured_at"), 0)
	local zone = ReadName(PlainField(t, "zone"))
	if not capturedAt or not zone then
		return nil
	end
	return {
		captured_at = capturedAt,
		map_id = ReadInteger(PlainField(t, "map_id"), 0),
		zone = zone,
		subzone = ReadString(PlainField(t, "subzone")),
		x = ReadNumber(PlainField(t, "x"), 0, 1),
		y = ReadNumber(PlainField(t, "y"), 0, 1),
		in_instance = ReadBoolean(PlainField(t, "in_instance")),
	}
end

-- Change returns "zone" when place is in another zone than last, "subzone"
-- when only its subzone differs, and nil when it is the same place, by the
-- rules above.
local function Change(last, place)
	if last.map_id and place.map_id then
		if last.map_id ~= place.map_id then
			return "zone"
		end
	elseif last.zone ~= place.zone then
		return "zone"
	end
	if place.subzone ~= nil and place.subzone ~= last.subzone then
		return "subzone"
	end
	return nil
end

-- Carried returns the newest RECENT_PATH_MAX entries of the path in the
-- OpenGamerMCPDB the client loaded, or an empty list when that table is
-- missing or belongs to a character other than guid.
local function Carried(guid)
	local saved = OpenGamerMCPDB
	local out = {}
	if not guid or ReadName(PlainField(PlainField(saved, "character"), "guid")) ~= guid then
		return out
	end
	local entries = ReadTable(PlainField(PlainField(saved, "state"), "recent_path"))
	for _, t in ipairs(entries or {}) do
		local entry = ReadEntry(t)
		if entry then
			entry.zone = ZoneName(entry.map_id) or entry.zone
			out[#out + 1] = entry
		end
	end
	while #out > RECENT_PATH_MAX do
		table.remove(out, 1)
	end
	return out
end

local function CollectRecentPath()
	if not path then
		path = Carried(ReadName(Api("UnitGUID", "player")))
	end
	local loc = CollectLocation()
	loc.captured_at = Api("GetServerTime")
	local place = ReadEntry(loc)
	local last = path[#path]
	local change = place and last and Change(last, place)
	if not place or (last and not change) then
		return path
	end
	if change == "subzone" then
		place.zone = last.zone
		local elapsed = place.captured_at - last.captured_at
		if elapsed >= 0 and elapsed < RECENT_PATH_MIN_INTERVAL then
			path[#path] = nil
			local before = path[#path]
			if before and not Change(before, place) then
				return path
			end
		end
	end
	path[#path + 1] = place
	if #path > RECENT_PATH_MAX then
		table.remove(path, 1)
	end
	return path
end

-- Read by the files after this one, and by the tests.
ns.RECENT_PATH_MAX = RECENT_PATH_MAX
ns.RECENT_PATH_MIN_INTERVAL = RECENT_PATH_MIN_INTERVAL
ns.CollectRecentPath = CollectRecentPath
