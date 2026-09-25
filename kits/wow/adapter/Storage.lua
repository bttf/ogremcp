-- Storage --------------------------------------------------------------------
--
-- OgreMCPDB is the account-wide SavedVariables table. It holds the
-- current character's latest state only, in the shape of
-- docs/architecture.md §6.3:
--
--   schema          SCHEMA, the adapter schema version
--   addon_version   the Version line of OgreMCP.toc
--   client          raw detection facts: project_id, season_id, version,
--                   build, interface. The interpreter maps them to a flavor
--                   and rules (§6.3.1); the adapter never decides the flavor.
--   character       guid, name, realm
--   captured_at     GetServerTime() when the table was written
--   state           the sections: character, location, quests, inventory,
--                   skills, recent_path
--
-- Write replaces the whole table. Only recent_path is read back
-- (RecentPath.lua). Every other part is rebuilt from live APIs, because WoW
-- Forever does not load SavedVariables after a reload (§6.3.1).

local addonName, ns = ...

local IsSecret = ns.IsSecret
local IsSecretTable = ns.IsSecretTable
local Lookup = ns.Lookup
local ReadName = ns.ReadName
local ReadInteger = ns.ReadInteger
local Api = ns.Api
local ApiEither = ns.ApiEither

local SCHEMA = 1
-- Tables nested deeper than this are left out. The deepest part of the state
-- is an item stat, at depth 6.
local CLEAN_MAX_DEPTH = 8

-- The client facts ------------------------------------------------------------

local function CollectClient()
	-- version string, build string, build date, interface number.
	local version, build, _, interface = Api("GetBuildInfo")
	build = ReadName(build) or ReadInteger(build, 0)
	if type(build) == "number" then
		build = string.format("%d", build)
	end
	return {
		project_id = ReadInteger(Lookup("WOW_PROJECT_ID"), 0),
		-- nil on a realm without a season. Since patch 1.15.3 the client
		-- returns nil there, not 0 (NoSeason).
		season_id = ReadInteger(Api("C_Seasons.GetActiveSeason"), 0),
		version = ReadName(version),
		build = build,
		interface = ReadInteger(interface, 1),
	}
end

-- CollectCharacterKey returns the character the state belongs to. The GUID is
-- the key; name and realm are for display.
local function CollectCharacterKey()
	local name = ReadName(Api("UnitName", "player"))
	local realm = ReadName(Api("GetRealmName"))
	if not name or not realm then
		error("player name or realm unreadable", 0)
	end
	return {
		guid = ReadName(Api("UnitGUID", "player")),
		name = name,
		realm = realm,
	}
end

local function AddonVersion()
	local ok, version = pcall(ApiEither, "C_AddOns.GetAddOnMetadata", "GetAddOnMetadata", addonName, "Version")
	return ok and ReadName(version) or nil
end

-- The secret-value guard ------------------------------------------------------
--
-- Clean returns a copy of v that holds only what SavedVariables can carry and
-- the client does not mark secret. The collectors already read every value
-- through the Read* helpers; Clean is the last check before the table is
-- written. It leaves out, and never compares or writes:
--
--   a secret value, a secret table, and a key that is secret
--   NaN and the infinities
--   functions, userdata, and threads
--   a key that is neither a string nor a positive whole number
--   a table nested CLEAN_MAX_DEPTH deep
--
-- A list keeps its order, and the entries left out leave no gaps. An empty
-- table stays an empty table.
local Clean
Clean = function(v, depth)
	if IsSecret(v) then
		return nil
	end
	local t = type(v)
	if t == "boolean" or t == "string" then
		return v
	elseif t == "number" then
		if v ~= v or v == math.huge or v == -math.huge then
			return nil
		end
		return v
	elseif t ~= "table" or IsSecretTable(v) or depth >= CLEAN_MAX_DEPTH then
		return nil
	end

	local out, indexes = {}, {}
	for k, child in pairs(v) do
		if IsSecret(k) then
			-- An unreadable key: the entry is left out.
		elseif type(k) == "string" then
			out[k] = Clean(child, depth + 1)
		elseif type(k) == "number" and k >= 1 and k < math.huge and k == math.floor(k) then
			indexes[#indexes + 1] = k
		end
	end
	table.sort(indexes)
	for _, i in ipairs(indexes) do
		local item = Clean(v[i], depth + 1)
		if item ~= nil then
			out[#out + 1] = item
		end
	end
	return out
end

-- Write ----------------------------------------------------------------------

-- Write replaces OgreMCPDB with parts, which maps each part of
-- COLLECT_PARTS (Collect.lua) to its value, and stamps captured_at. A part
-- without a value is left out.
local function Write(parts, partList)
	local db = {
		schema = SCHEMA,
		addon_version = AddonVersion(),
		state = {},
	}
	for _, part in ipairs(partList) do
		local target = part.top and db or db.state
		target[part.key] = parts[part]
	end
	-- Stamped last, so it matches the moment the state was read.
	db.captured_at = ReadInteger(Api("GetServerTime"), 0)
	OgreMCPDB = Clean(db, 0)
end

-- Read by the files after this one.
ns.CollectClient = CollectClient
ns.CollectCharacterKey = CollectCharacterKey
ns.Clean = Clean
ns.Write = Write
