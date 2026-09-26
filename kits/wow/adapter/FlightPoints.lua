-- Section: flight_points -----------------------------------------------------
--
-- flight_points holds the flight points the character knows, per continent
-- (docs/architecture.md §6.3). It follows the retail addon MissingFlightPaths
-- 2.1.4 (MissingFlightPaths.lua and MFP_Helpers.lua):
--
--   - Only TAXIMAP_OPENED reads the nodes, with
--     C_TaxiMap.GetAllTaxiNodes(WorldMapFrame:GetMapID()).
--   - A node is known when its state is 0 (current) or 1 (reachable).
--   - A read with no node in state 0 is skipped.
--   - The nodes are kept per continent, keyed by the instance ID of the
--     player's position.
--
-- There is no discovery detection outside the taxi map. The reference keeps
-- the nodes the character lacks and replaces them on each read; this keeps
-- the known ones and merges, as §6.3 says.
--
-- The cache is OgreMCPCharDB.flight_points, in the per-character
-- SavedVariables table (## SavedVariablesPerCharacter in OgreMCP.toc). It maps
-- an instance ID to { known = names, sorted, continent = name, updated_at =
-- GetServerTime() }. A read merges its names into the entry of its continent:
-- the union with the names already there. Other continents are untouched. A
-- continent with no entry has not been observed.
--
-- The section copies the cache: { continents = a list of { instance_id,
-- continent, known, updated_at }, by instance ID }. OgreMCPCharDB is per
-- character, so OgreMCPDB carries only the current character's entries. An
-- empty list means the character has not opened a taxi map that the addon
-- saw; the interpreter reports it as unknown. WoW Forever builds 69893 and
-- 69913 do not read SavedVariables back (§6.3.1), so there the cache starts
-- empty at each reload.
--
-- Left out of the reference, because they are retail-only or draw on the map:
--
--   - The bad-node list (MFP_NodeData.lua). It holds retail node IDs, and
--     some are live Classic Era flight points, such as 27, Rut'theran Village.
--   - The early return on a current node with a textureKit, a field added in
--     patch 9.0.1.
--   - The map ID workaround for Khaz Algar, a retail map.
--   - The pins, FlightMapFrame (the retail flight map), and the scouting maps.
--     The adapter draws nothing.

local addonName, ns = ...

local PlainField = ns.PlainField
local Lookup = ns.Lookup
local ReadName = ns.ReadName
local ReadInteger = ns.ReadInteger
local ReadTable = ns.ReadTable
local Api = ns.Api

local FLIGHT_POINTS = {
	-- Enum.FlightPathState: Current, Reachable. Unreachable is 2.
	CURRENT = 0,
	REACHABLE = 1,
	-- Enum.UIMapType.Continent.
	CONTINENT_MAP = 2,
	-- Most maps read for one continent name, which stops a loop of parents.
	MAX_READS = 5,
}

-- Cache returns OgreMCPCharDB.flight_points, and creates it when missing.
local function Cache()
	if type(OgreMCPCharDB) ~= "table" then
		OgreMCPCharDB = {}
	end
	if type(OgreMCPCharDB.flight_points) ~= "table" then
		OgreMCPCharDB.flight_points = {}
	end
	return OgreMCPCharDB.flight_points
end

-- Names returns the readable names in the given lists, each once, sorted. A
-- secret name reads as nil and is left out.
local function Names(...)
	local seen, out = {}, {}
	for i = 1, select("#", ...) do
		for _, name in ipairs(ReadTable((select(i, ...))) or {}) do
			name = ReadName(name)
			if name and not seen[name] then
				seen[name] = true
				out[#out + 1] = name
			end
		end
	end
	table.sort(out)
	return out
end

-- TaxiMapID returns the map ID to read the taxi nodes for.
local function TaxiMapID()
	-- Retail -> Classic Era: WorldMapFrame:GetMapID() exists in Classic Era
	-- too. It can return nil, so the player's map is the fallback.
	local frame = Lookup("WorldMapFrame")
	local getMapID = PlainField(frame, "GetMapID")
	if type(getMapID) == "function" then
		local ok, mapID = pcall(getMapID, frame)
		mapID = ok and ReadInteger(mapID, 0)
		if mapID then
			return mapID
		end
	end
	return ReadInteger(Api("C_Map.GetBestMapForUnit", "player"), 0)
end

-- ContinentName returns the name of the continent map above the player's map,
-- or nil when there is none or it is unreadable.
local function ContinentName()
	-- Retail -> Classic Era: the reference stores no continent name. This one
	-- is for the agent to read.
	local mapID = ReadInteger(Api("C_Map.GetBestMapForUnit", "player"), 0)
	for _ = 1, FLIGHT_POINTS.MAX_READS do
		local info = mapID and ReadTable(Api("C_Map.GetMapInfo", mapID))
		if not info then
			return nil
		end
		if ReadInteger(PlainField(info, "mapType")) == FLIGHT_POINTS.CONTINENT_MAP then
			return ReadName(PlainField(info, "name"))
		end
		mapID = ReadInteger(PlainField(info, "parentMapID"), 1)
	end
	return nil
end

-- ReadTaxiMap merges the known nodes of the open taxi map into the cache.
local function ReadTaxiMap()
	-- C_TaxiMap.GetAllTaxiNodes exists in Classic Era since patch 1.13.2.
	local nodes = ReadTable(Api("C_TaxiMap.GetAllTaxiNodes", TaxiMapID()))
	if not nodes then
		return
	end
	local known, current = {}, false
	for _, node in pairs(nodes) do
		local state = ReadInteger(PlainField(node, "state"))
		if state == FLIGHT_POINTS.CURRENT then
			current = true
		end
		if state == FLIGHT_POINTS.CURRENT or state == FLIGHT_POINTS.REACHABLE then
			known[#known + 1] = PlainField(node, "name")
		end
	end
	-- The reference's `if c == nil then return end`: without a current node
	-- the nodes are not ready.
	if not current then
		return
	end

	-- Retail -> Classic Era: the reference keys by the instance ID from
	-- HereBeDragons' GetPlayerWorldPosition, which is not bundled here. That
	-- is the fourth return of UnitPosition("player"); HereBeDragons' instance
	-- overrides are all retail maps. UnitPosition returns nil in an instance,
	-- where there is no taxi map, and then nothing is kept.
	local instanceID = ReadInteger((select(4, Api("UnitPosition", "player"))), 0)
	if not instanceID then
		return
	end
	local cache = Cache()
	local old = ReadTable(cache[instanceID])
	cache[instanceID] = {
		known = Names(PlainField(old, "known"), known),
		continent = ContinentName() or ReadName(PlainField(old, "continent")),
		updated_at = ReadInteger(Api("GetServerTime"), 0),
	}
end

local function CollectFlightPoints()
	local continents = {}
	for instanceID, entry in pairs(Cache()) do
		instanceID = ReadInteger(instanceID, 0)
		entry = ReadTable(entry)
		if instanceID and entry then
			continents[#continents + 1] = {
				instance_id = instanceID,
				continent = ReadName(PlainField(entry, "continent")),
				known = Names(PlainField(entry, "known")),
				updated_at = ReadInteger(PlainField(entry, "updated_at"), 0),
			}
		end
	end
	table.sort(continents, function(a, b)
		return a.instance_id < b.instance_id
	end)
	return { continents = continents }
end

-- A failed read changes nothing: it runs in a protected call, like each part
-- of a collection (Collect.lua), and the cache entry is replaced only after
-- every value is read.
local flightPointsFrame = CreateFrame("Frame")
flightPointsFrame:RegisterEvent("ADDON_LOADED")
pcall(flightPointsFrame.RegisterEvent, flightPointsFrame, "TAXIMAP_OPENED")
flightPointsFrame:SetScript("OnEvent", function(_, event, name)
	if event == "ADDON_LOADED" then
		if name == addonName then
			Cache()
		end
	elseif event == "TAXIMAP_OPENED" then
		pcall(ReadTaxiMap)
	end
end)

-- Read by the files after this one, and by the tests.
ns.CollectFlightPoints = CollectFlightPoints
