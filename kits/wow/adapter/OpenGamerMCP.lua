-- Open Gamer MCP, the WoW adapter (docs/architecture.md §6.3). It keeps the
-- current character's state in the account-wide SavedVariables table
-- OpenGamerMCPDB. The client writes that table to disk on a UI reload and on
-- logout, and the bridge uploads the file.
--
-- The addon is split into files that OpenGamerMCP.toc lists in load order:
--
--   OpenGamerMCP.lua  this overview, and the secret-value helpers every file uses
--   Collectors.lua    value readers and the character, location, quests, and
--                     skills sections
--   Items.lua         item details and the inventory section
--   RecentPath.lua    the recent_path section, the one section carried across
--                     reloads
--   Storage.lua       the client facts, the secret-value guard, and the
--                     OpenGamerMCPDB write
--   Collect.lua       collection, its scheduling, and the write at PLAYER_LOGOUT
--   Transmit.lua      /transmit, the only command
--
-- The files share the private addon table ns, the second value of `...`, and
-- keep few file-level locals: Lua allows 200 locals in a file's main chunk
-- (RED-268). A file copies what it uses from an earlier file into locals at
-- its top. A value that changes after load is read from ns when it is used.
--
-- APIs are chosen by feature detection, never by a flavor or client check
-- (§6.4). The adapter records raw client facts and never decides the flavor
-- (§6.3.1).

local _, ns = ...

-- Longest error message kept by SafeMessage.
local SAFE_MESSAGE_MAX = 4000

-- Secret values (patch 12.0.0, warcraft.wiki.gg/wiki/Secret_Values).
--
-- Addon code is tainted, so a secret value returned to it can be stored in a
-- variable or table value and passed to functions, and type() on it returns the
-- underlying type. Arithmetic, comparison, the # operator, indexing, use as a
-- table key, and boolean tests of a secret boolean all raise errors. A secret
-- table (issecrettable, or canaccesstable == false) errors on any index,
-- assignment, length, or iteration.
--
-- Detection uses the client's issecretvalue(value). The predicate is looked up
-- at call time and guarded, because this client may not ship it. Without it,
-- the fallback is an equality test inside pcall: v == v errors on a secret and
-- succeeds on every other value. A client without issecretvalue most likely has
-- no secret values at all, so the fallback should never report a secret there.
--
-- No value is inspected before IsSecret has cleared it, and no secret value is
-- ever written to OpenGamerMCPDB.

local function IsSecret(v)
	local predicate = issecretvalue
	if type(predicate) == "function" then
		local ok, result = pcall(function()
			return predicate(v) == true
		end)
		if ok then
			return result
		end
	end
	return not pcall(function()
		return v == v
	end)
end

local function IsSecretTable(t)
	local check = issecrettable
	if type(check) == "function" then
		local ok, result = pcall(function()
			return check(t) == true
		end)
		if ok and result then
			return true
		end
	end
	local access = canaccesstable
	if type(access) == "function" then
		local ok, result = pcall(function()
			return access(t) == true
		end)
		if ok and not result then
			return true
		end
	end
	-- Iteration errors on an inaccessible table whatever the predicates said.
	return not pcall(next, t)
end

local function SafeMessage(e)
	if IsSecret(e) then
		return "<secret>"
	end
	local text = tostring(e)
	if #text > SAFE_MESSAGE_MAX then
		text = string.sub(text, 1, SAFE_MESSAGE_MAX)
	end
	return text
end

-- Lookup returns the global at a dotted path such as "C_Map.GetBestMapForUnit",
-- or nil when any part of it is missing.
local function Lookup(path)
	local ok, node = pcall(function()
		local current = _G
		for part in string.gmatch(path, "[^%.]+") do
			if type(current) ~= "table" then
				return nil
			end
			current = current[part]
		end
		return current
	end)
	if ok then
		return node
	end
	return nil
end

-- PlainField returns tbl[key], or nil when the table or the value is secret
-- or the index errors.
local function PlainField(tbl, key)
	if type(tbl) ~= "table" or IsSecret(tbl) or IsSecretTable(tbl) then
		return nil
	end
	local ok, v = pcall(function()
		return tbl[key]
	end)
	if not ok or IsSecret(v) then
		return nil
	end
	return v
end

-- Read by the files after this one.
ns.IsSecret = IsSecret
ns.IsSecretTable = IsSecretTable
ns.SafeMessage = SafeMessage
ns.Lookup = Lookup
ns.PlainField = PlainField
