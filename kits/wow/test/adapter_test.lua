-- Tests for the adapter in kits/wow/adapter, run under LuaJIT (Lua 5.1) with
-- the WoW API stubbed. All data is synthetic.
--
--   luajit test/adapter_test.lua [out-dir]
--
-- Each client's run writes OpenGamerMCPDB the way the client writes a
-- SavedVariables file and reads the file back. With out-dir, the files are
-- written there as <client>.lua. test/run.mjs runs this file.

local here = string.match(arg[0], "^(.*)[/\\]") or "."
local ADDON_DIR = here .. "/../adapter"
local ADDON_NAME = "OpenGamerMCP"
local outDir = arg[1]

-- ADDON_FILES are the paths of the Lua files the TOC lists, in the order the
-- client loads them. A TOC line that is blank or starts with # is not a file.
-- TOC_META holds the TOC's "## Key: value" lines.
local ADDON_FILES, TOC_META = {}, {}
do
	local f = assert(io.open(ADDON_DIR .. "/" .. ADDON_NAME .. ".toc"))
	for line in f:lines() do
		line = string.match(line, "^%s*(.-)%s*$")
		local key, value = string.match(line, "^##%s*([%w-]+):%s*(.-)$")
		if key then
			TOC_META[key] = value
		elseif line ~= "" and string.sub(line, 1, 1) ~= "#" then
			assert(string.find(line, "%.lua$"), "the TOC lists a file that is not Lua: " .. line)
			ADDON_FILES[#ADDON_FILES + 1] = ADDON_DIR .. "/" .. string.gsub(line, "\\", "/")
		end
	end
	f:close()
	assert(#ADDON_FILES > 0, "the TOC lists no files")
end

-- SavedVariables ---------------------------------------------------------------

-- WriteSavedVariables writes OpenGamerMCPDB the way both clients were seen to
-- write a SavedVariables file: an empty first line, CRLF line endings, one
-- entry per line with no indentation and no index comments, and strings in
-- double quotes with backslash, double quote, newline, and carriage return
-- escaped. Object keys are sorted here so the output is stable; the client
-- does not sort them. A value SavedVariables cannot hold raises an error, so
-- a secret stub (a userdata) that reached the table fails the test.
local LUA_ESCAPES = { ["\\"] = "\\\\", ['"'] = '\\"', ["\n"] = "\\n", ["\r"] = "\\r" }

local function LuaQuote(s)
	return '"' .. string.gsub(s, '[\\"\n\r]', LUA_ESCAPES) .. '"'
end

local function WriteValue(v, out, path)
	local t = type(v)
	if t == "string" then
		out[#out + 1] = LuaQuote(v)
	elseif t == "number" then
		assert(v == v and v ~= math.huge and v ~= -math.huge, "non-finite number at " .. path)
		out[#out + 1] = v == math.floor(v) and string.format("%d", v) or string.format("%.17g", v)
	elseif t == "boolean" then
		out[#out + 1] = tostring(v)
	elseif t == "table" then
		out[#out + 1] = "{\r\n"
		local n = #v
		for i = 1, n do
			WriteValue(v[i], out, path .. "[" .. i .. "]")
			out[#out + 1] = ",\r\n"
		end
		local keys = {}
		for k in pairs(v) do
			if not (type(k) == "number" and k >= 1 and k <= n and k == math.floor(k)) then
				assert(type(k) == "string" or type(k) == "number", "unsupported key type at " .. path)
				keys[#keys + 1] = k
			end
		end
		table.sort(keys, function(a, b)
			return tostring(a) < tostring(b)
		end)
		for _, k in ipairs(keys) do
			out[#out + 1] = "[" .. (type(k) == "string" and LuaQuote(k) or tostring(k)) .. "] = "
			WriteValue(v[k], out, path .. "." .. tostring(k))
			out[#out + 1] = ",\r\n"
		end
		out[#out + 1] = "}"
	else
		error("cannot write " .. t .. " to SavedVariables at " .. path)
	end
end

local function WriteSavedVariables()
	local out = { "\r\nOpenGamerMCPDB = " }
	WriteValue(OpenGamerMCPDB, out, "OpenGamerMCPDB")
	out[#out + 1] = "\r\n"
	return table.concat(out)
end

-- ReadSavedVariables loads SavedVariables text in an empty environment and
-- returns the OpenGamerMCPDB it defines.
local function ReadSavedVariables(text)
	local env = {}
	local chunk = assert(loadstring(text, "SavedVariables"))
	setfenv(chunk, env)
	chunk()
	return env.OpenGamerMCPDB
end

-- Test runner ----------------------------------------------------------------

local tests = {}
local function test(name, fn)
	tests[#tests + 1] = { name = name, fn = fn }
end

local function fail(message, level)
	error(message, (level or 1) + 1)
end

local function eq(actual, expected, label)
	if actual ~= expected then
		fail(string.format("%s: expected %s, got %s", label or "value", tostring(expected), tostring(actual)), 2)
	end
end

local function truthy(v, label)
	if not v then
		fail((label or "value") .. " was not truthy", 2)
	end
end

-- Keys returns the sorted keys of t joined by commas.
local function Keys(t)
	local keys = {}
	for k in pairs(t) do
		keys[#keys + 1] = tostring(k)
	end
	table.sort(keys)
	return table.concat(keys, ",")
end

-- WoW API stubs --------------------------------------------------------------

-- Secret values are userdata that error on indexing, length, concatenation,
-- and tostring, like a secret in the client. issecretvalue recognises them.
-- Limit: in the client a secret also errors on == and on a boolean test, and
-- Lua 5.1 userdata cannot simulate either. `v == v` on the same userdata never
-- calls __eq, and every userdata is truthy. A collector that compares or tests
-- a value before IsSecret has cleared it will not fail here.
local secretSet = setmetatable({}, { __mode = "k" })
local function Secret()
	local s = newproxy(true)
	local mt = getmetatable(s)
	local function boom()
		error("attempt to use a secret value", 2)
	end
	mt.__index = boom
	mt.__len = boom
	mt.__concat = boom
	mt.__tostring = boom
	secretSet[s] = true
	return s
end

-- A secret table: issecrettable recognises it. Unlike the client's, it can
-- still be iterated, so only the predicate keeps it out.
local secretTables = setmetatable({}, { __mode = "k" })
local function SecretTable(t)
	secretTables[t] = true
	return t
end

local function Link(id, name)
	return "|cffffffff|Hitem:" .. id .. "::::::::12:::::|h[" .. name .. "]|h|r"
end

local SLOT_IDS = {
	HeadSlot = 1, NeckSlot = 2, ShoulderSlot = 3, ShirtSlot = 4, ChestSlot = 5,
	WaistSlot = 6, LegsSlot = 7, FeetSlot = 8, WristSlot = 9, HandsSlot = 10,
	Finger0Slot = 11, Finger1Slot = 12, Trinket0Slot = 13, Trinket1Slot = 14,
	BackSlot = 15, MainHandSlot = 16, SecondaryHandSlot = 17, RangedSlot = 18,
	TabardSlot = 19,
}

-- DefaultWorld is a level-12 character in the open world of WoW Forever,
-- with two quests under one header, a few bag items, and two equipped items.
local function DefaultWorld()
	return {
		now = 100,
		-- Server time at now = 100. It advances with the clock.
		serverTime = 1789654086,
		-- "forever" stubs the C_QuestLog forms and "era" stubs the Classic Era
		-- globals, as the prototype's docs/api-probe.md records for each client.
		client = "forever",
		build = { version = "1.60.1", build = "69893", interface = 16001 },
		projectID = 1,
		-- The value of C_Seasons.GetActiveSeason(). Only the Era stub has it.
		season = nil,
		char = {
			guid = "Player-0000-00000001", name = "Grimble", realm = "Testrealm", class = "Warrior",
			race = "Dwarf", faction = "Alliance", level = 12, xp = 3000, xpMax = 7600, rested = nil, money = 12345,
		},
		loc = {
			mapID = 1429, x = 0.4312, y = 0.6127, zone = "Test Forest", subzone = "Test Village",
			facing = 3.1, inInstance = false,
		},
		questLog = {
			{ header = true, title = "Test Forest" },
			{
				id = 100, title = "A Test Errand", level = 11, complete = false,
				description = "Bring the parcel to the smith.", objectivesText = "Deliver the parcel.",
				objectives = {
					{ text = "Parcel delivered: 0/1", type = "event", finished = false, numFulfilled = 0, numRequired = 1 },
				},
			},
			{
				id = 101, title = "Talk to Someone", level = 10, complete = true,
				description = "Go and talk to someone.", objectivesText = "Talk to someone.",
				objectives = {},
			},
		},
		selected = 55,
		-- The Era selection is a log index. 0 means nothing is selected.
		selectedIndex = 3,
		bags = {
			[0] = {
				size = 16,
				slots = {
					[1] = { itemID = 2000, itemName = "Test Bread", hyperlink = Link(2000, "Test Bread"), stackCount = 4 },
					[5] = { itemID = 2000, itemName = "Test Bread", hyperlink = Link(2000, "Test Bread"), stackCount = 2 },
					[6] = { itemID = 2001, hyperlink = Link(2001, "Test Hide"), stackCount = 1 },
				},
			},
			[1] = { size = 6, slots = {} },
		},
		gear = {
			HeadSlot = { id = 3000, link = Link(3000, "Test Cap") },
			MainHandSlot = { id = 3001, link = Link(3001, "Test Club") },
		},
		-- What the client knows about each item, keyed by link. All invented.
		items = {
			[Link(2000, "Test Bread")] = {
				info = { name = "Test Bread", quality = 1, itemLevel = 5, minLevel = 1, type = "Consumable",
					subType = "Food & Drink", stackCount = 20, sellPrice = 1 },
			},
			[Link(2001, "Test Hide")] = {
				info = { name = "Test Hide", quality = 1, itemLevel = 10, minLevel = 0, type = "Trade Goods",
					subType = "Leather", stackCount = 20, sellPrice = 15 },
			},
			[Link(3000, "Test Cap")] = {
				info = { name = "Test Cap", quality = 2, itemLevel = 14, minLevel = 9, type = "Armor",
					subType = "Leather", equipLoc = "INVTYPE_HEAD", sellPrice = 310 },
				stats = { RESISTANCE0_NAME = 41, ITEM_MOD_AGILITY_SHORT = 2 },
				tooltip = { { "Test Cap" }, { "Head", "Leather" }, { "41 Armor" } },
			},
			[Link(3001, "Test Club")] = {
				info = { name = "Test Club", quality = 1, itemLevel = 10, minLevel = 5, type = "Weapon",
					subType = "One-Handed Maces", equipLoc = "INVTYPE_WEAPON", sellPrice = 120 },
				stats = { ITEM_MOD_DAMAGE_PER_SECOND_SHORT = 5.3 },
				tooltip = { { "Test Club" }, { "Main Hand", "Mace" }, { "7 - 11 Damage", "Speed 1.70" } },
			},
		},
		state = { dead = false, ghost = false, combat = false, lockdown = false, resting = true, bind = "Test Village" },
		-- The rows of the Skills tab, in the fields of WoW Forever's
		-- C_SkillInfo.GetSkillLineInfo table. A header's skillID is its
		-- category ID. The Era stub returns the same rows as its globals do.
		skills = {
			{ header = true, name = "Professions", skillID = 11 },
			{ name = "Mining", skillID = 186, categoryID = 11, rank = 42, maxRank = 75, modifier = 0 },
			{ header = true, name = "Weapon Skills", skillID = 6 },
			{ name = "Maces", skillID = 54, categoryID = 6, rank = 58, maxRank = 60, modifier = 0 },
			{ name = "Defense", skillID = 95, categoryID = 6, rank = 60, maxRank = 60, modifier = 3 },
		},
		timers = {},
		frames = {},
		chat = {},
		calls = { reloadUI = 0, cReload = 0 },
		reload = { global = true, c = true },
	}
end

-- Era turns DefaultWorld into Classic Era, then applies setup.
local function Era(setup)
	return function(w)
		w.client = "era"
		w.build = { version = "1.15.9", build = "69722", interface = 11509 }
		w.projectID = 2
		if setup then
			setup(w)
		end
	end
end

local world

local function Frame()
	local frame = { events = {}, visible = false }
	function frame:RegisterEvent(event)
		self.events[event] = true
	end
	function frame:UnregisterEvent(event)
		self.events[event] = nil
	end
	function frame:SetScript(name, fn)
		self[name] = fn
	end
	function frame:IsVisible()
		return self.visible
	end
	return frame
end

local function Fire(event, ...)
	for _, frame in ipairs(world.frames) do
		if frame.events[event] and frame.OnEvent then
			frame.OnEvent(frame, event, ...)
		end
	end
end

local function Schedule(delay, fn, ticker)
	local timer = { at = world.now + delay, fn = fn, ticker = ticker }
	world.timers[#world.timers + 1] = timer
	return timer
end

-- Advance moves the clock forward, running due timers in time order.
local function Advance(seconds)
	local target = world.now + seconds
	while true do
		local nextTimer, nextIndex
		for i, timer in ipairs(world.timers) do
			if timer.at <= target and (not nextTimer or timer.at < nextTimer.at) then
				nextTimer, nextIndex = timer, i
			end
		end
		if not nextTimer then
			break
		end
		table.remove(world.timers, nextIndex)
		world.now = math.max(world.now, nextTimer.at)
		if nextTimer.ticker then
			if not nextTimer.ticker.cancelled then
				Schedule(nextTimer.ticker.interval, nextTimer.fn, nextTimer.ticker)
				nextTimer.fn()
			end
		else
			nextTimer.fn()
		end
	end
	world.now = target
end

local function Row(index)
	return world.questLog[index]
end

local function InstallStubs()
	local w = world
	local G = _G

	G.issecretvalue = function(v)
		return secretSet[v] == true
	end
	G.issecrettable = function(t)
		return secretTables[t] == true
	end
	G.canaccesstable = function()
		return true
	end

	G.CreateFrame = function()
		local frame = Frame()
		w.frames[#w.frames + 1] = frame
		return frame
	end
	G.DEFAULT_CHAT_FRAME = {
		AddMessage = function(_, text)
			w.chat[#w.chat + 1] = text
		end,
	}
	G.SlashCmdList = {}
	G.C_Timer = {
		After = function(delay, fn)
			Schedule(delay, fn)
		end,
		NewTicker = function(interval, fn)
			local ticker = { interval = interval }
			function ticker:Cancel()
				self.cancelled = true
			end
			Schedule(interval, fn, ticker)
			return ticker
		end,
	}
	G.GetTime = function()
		return w.now
	end
	G.GetServerTime = function()
		return w.serverTime + math.floor(w.now - 100)
	end

	G.GetBuildInfo = function()
		local b = w.build
		return b.version, b.build, "Sep 1 2026", b.interface, "", "Release ", b.interface
	end
	G.WOW_PROJECT_ID = w.projectID
	G.C_Seasons = w.client == "era" and {
		GetActiveSeason = function()
			return w.season
		end,
	} or nil
	-- Forever has C_AddOns.GetAddOnMetadata and Era has the global. The
	-- version comes from the TOC.
	local function metadata(name, field)
		return name == ADDON_NAME and TOC_META[field] or nil
	end
	G.C_AddOns = w.client ~= "era" and { GetAddOnMetadata = metadata } or nil
	G.GetAddOnMetadata = w.client == "era" and metadata or nil

	G.UnitGUID = function()
		return w.char.guid
	end
	G.UnitName = function()
		return w.char.name
	end
	G.GetRealmName = function()
		return w.char.realm
	end
	G.UnitClass = function()
		return w.char.class, "WARRIOR", 1
	end
	G.UnitRace = function()
		return w.char.race, "Dwarf", 3
	end
	G.UnitFactionGroup = function()
		return w.char.faction, w.char.faction
	end
	G.UnitLevel = function()
		return w.char.level
	end
	G.UnitXP = function()
		return w.char.xp
	end
	G.UnitXPMax = function()
		return w.char.xpMax
	end
	G.GetXPExhaustion = function()
		return w.char.rested
	end
	G.GetMoney = function()
		return w.char.money
	end
	G.UnitIsDead = function()
		return w.state.dead
	end
	G.UnitIsGhost = function()
		return w.state.ghost
	end
	G.UnitAffectingCombat = function()
		return w.state.combat
	end
	G.InCombatLockdown = function()
		return w.state.lockdown
	end
	G.IsResting = function()
		return w.state.resting
	end
	G.GetBindLocation = function()
		return w.state.bind
	end

	G.C_Map = {
		GetBestMapForUnit = function()
			return w.loc.mapID
		end,
		GetPlayerMapPosition = function()
			if w.loc.x == nil then
				return nil
			end
			return {
				x = w.loc.x,
				y = w.loc.y,
				GetXY = function(self)
					return self.x, self.y
				end,
			}
		end,
	}
	G.GetRealZoneText = function()
		return w.loc.zone
	end
	G.GetSubZoneText = function()
		return w.loc.subzone
	end
	G.GetPlayerFacing = function()
		return w.loc.facing
	end
	G.IsInInstance = function()
		return w.loc.inInstance, w.loc.inInstance and "party" or "none"
	end

	G.C_QuestLog = {
		GetNumQuestLogEntries = function()
			if w.questError then
				error("synthetic quest log failure")
			end
			local quests = 0
			for _, row in ipairs(w.questLog) do
				if not row.header then
					quests = quests + 1
				end
			end
			return #w.questLog, quests
		end,
		IsOnQuest = function(questID)
			for _, row in ipairs(w.questLog) do
				if row.id == questID then
					return true
				end
			end
			return false
		end,
		GetInfo = function(index)
			local row = Row(index)
			if not row then
				return nil
			end
			return {
				title = row.title,
				questID = row.id or 0,
				level = row.level or 0,
				isHeader = row.header == true,
				isHidden = row.hidden == true,
				questLogIndex = index,
			}
		end,
		IsComplete = function(questID)
			for _, row in ipairs(w.questLog) do
				if row.id == questID then
					return row.complete
				end
			end
			return false
		end,
		GetQuestObjectives = function(questID)
			for _, row in ipairs(w.questLog) do
				if row.id == questID then
					return row.objectives
				end
			end
			return nil
		end,
		GetSelectedQuest = function()
			return w.selected
		end,
		SetSelectedQuest = function(questID)
			w.selected = questID
		end,
	}
	-- WoW Forever reads the quest at the index argument. The Classic Era UI
	-- reads quest text only after selecting the quest, so the Era stub returns
	-- text only for the selected quest: an Era collector that forgets to select
	-- gets empty text.
	G.GetQuestLogQuestText = function(index)
		local row
		if w.client ~= "era" then
			row = Row(index)
		else
			row = Row(index or w.selectedIndex)
			if row and row.id ~= w.selected then
				row = nil
			end
		end
		if not row or not row.id then
			return "", ""
		end
		return row.description, row.objectivesText
	end

	-- Classic Era has the quest globals and lacks the C_QuestLog forms of
	-- them. It keeps C_QuestLog.GetQuestObjectives and C_QuestLog.IsOnQuest.
	local eraGlobals = {
		GetNumQuestLogEntries = G.C_QuestLog.GetNumQuestLogEntries,
		GetQuestLogTitle = function(index)
			local row = Row(index)
			if not row then
				return nil
			end
			-- Positions 9 to 17 are startEvent, displayQuestID, isOnMap,
			-- hasLocalPOI, isTask, isBounty, isStory, isHidden, isScaling.
			return row.title, row.level or 0, nil, row.header == true, false, nil, 0, row.id or 0,
				false, false, false, false, false, false, false, row.hidden == true, false
		end,
		IsQuestComplete = G.C_QuestLog.IsComplete,
		GetQuestLogSelection = function()
			return w.selectedIndex
		end,
		SelectQuestLogEntry = function(index)
			w.selectedIndex = index
			local row = Row(index)
			w.selected = row and row.id or nil
		end,
	}
	if w.client == "era" then
		G.C_QuestLog = {
			GetQuestObjectives = G.C_QuestLog.GetQuestObjectives,
			IsOnQuest = G.C_QuestLog.IsOnQuest,
		}
	end
	for name, fn in pairs(eraGlobals) do
		G[name] = w.client == "era" and fn or nil
	end

	G.C_Container = {
		GetContainerNumSlots = function(bag)
			local b = w.bags[bag]
			return b and b.size or 0
		end,
		GetContainerItemInfo = function(bag, slot)
			local b = w.bags[bag]
			return b and b.slots[slot] or nil
		end,
	}
	G.GetInventorySlotInfo = function(name)
		local id = SLOT_IDS[name]
		if not id then
			error("Invalid inventory slot in GetInventorySlotInfo")
		end
		return id
	end
	local function GearBySlot(slotID)
		for name, id in pairs(SLOT_IDS) do
			if id == slotID then
				return w.gear[name]
			end
		end
	end
	G.GetInventoryItemLink = function(_, slotID)
		local gear = GearBySlot(slotID)
		return gear and gear.link or nil
	end
	G.GetInventoryItemID = function(_, slotID)
		local gear = GearBySlot(slotID)
		return gear and gear.id or nil
	end

	-- Item details. The "era" world is what probe version 5 saw in Classic
	-- Era: GetItemInfo and C_Item.GetItemInfo both exist, only the global
	-- GetItemStats exists, C_TooltipInfo is missing, and a hidden GameTooltip
	-- can be created and filled with SetHyperlink. The "forever" world is given
	-- the other form of each API, C_Item.GetItemStats and C_TooltipInfo, so
	-- that each path of the collector runs.
	local function getItemInfo(key)
		local item = w.items[key]
		if not item then
			return nil
		end
		local i = item.info
		local equipLoc = i.equipLoc or (w.client == "era" and "" or "INVTYPE_NON_EQUIP_IGNORE")
		return i.name, key, i.quality, i.itemLevel, i.minLevel, i.type, i.subType, i.stackCount or 1, equipLoc,
			134400, i.sellPrice, 0, 0, 0, 0, nil, false, ""
	end
	local function getItemStats(key)
		local item = w.items[key]
		return item and (item.stats or {}) or nil
	end
	local function tooltipRows(key)
		local item = w.items[key]
		return item and item.tooltip or {}
	end
	local era = w.client == "era"
	G.GetItemInfo = era and getItemInfo or nil
	G.GetItemStats = era and getItemStats or nil
	G.C_Item = {
		GetItemInfo = getItemInfo,
		GetItemStats = not era and getItemStats or nil,
	}
	G.C_TooltipInfo = not era and {
		GetHyperlink = function(link)
			local lines = {}
			for i, row in ipairs(tooltipRows(link)) do
				lines[i] = { leftText = row[1], rightText = row[2], type = 0 }
			end
			return { type = 0, lines = lines }
		end,
	} or nil
	G.DAMAGE_TEMPLATE = "%s - %s Damage"
	G.SPEED = "Speed"
	-- A hidden tooltip: CreateFrame("GameTooltip", name, parent, template). Its
	-- font strings are globals named after it, as GameTooltipTemplate makes
	-- them.
	local createFrame = G.CreateFrame
	G.CreateFrame = function(frameType, name, parent)
		if frameType ~= "GameTooltip" then
			return createFrame(frameType, name, parent)
		end
		if not era then
			error("synthetic: no GameTooltip frame type")
		end
		local tip = { rows = {} }
		function tip:SetOwner() end
		function tip:ClearLines()
			self.rows = {}
		end
		function tip:SetHyperlink(link)
			self.rows = tooltipRows(link)
		end
		function tip:NumLines()
			return #self.rows
		end
		function tip:Hide() end
		for i = 1, 30 do
			for side, column in pairs({ Left = 1, Right = 2 }) do
				G[name .. "Text" .. side .. i] = {
					GetText = function()
						local row = tip.rows[i]
						return row and row[column] or nil
					end,
				}
			end
		end
		return tip
	end

	-- Skills. WoW Forever has C_SkillInfo and Classic Era has the globals.
	local function numSkillLines()
		return #w.skills
	end
	G.C_SkillInfo = not era and {
		GetNumSkillLines = numSkillLines,
		GetSkillLineInfo = function(index)
			local row = w.skills[index]
			if not row then
				return nil
			end
			return {
				skillID = row.skillID or 0,
				name = row.name,
				isHeader = row.header == true,
				isCollapsed = false,
				rank = row.rank or 0,
				modifier = row.modifier or 0,
				maxRank = row.maxRank or 0,
				parentSkillLineID = 0,
				skillLineCategoryID = row.header and 0 or row.categoryID or 0,
			}
		end,
	} or nil
	G.GetNumSkillLines = era and numSkillLines or nil
	-- skillName, isHeader, isExpanded, skillRank, numTempPoints,
	-- skillModifier, skillMaxRank, and more.
	G.GetSkillLineInfo = era and function(index)
		local row = w.skills[index]
		if not row then
			return nil
		end
		return row.name, row.header == true, row.header == true, row.rank or 0, 0, row.modifier or 0,
			row.maxRank or 0, false, 0, 0, 0, 0, ""
	end or nil

	-- Both clients have ReloadUI and C_UI.Reload. The stub counts the calls and
	-- reloads nothing. w.reload chooses which forms exist.
	G.ReloadUI = w.reload.global and function()
		w.calls.reloadUI = w.calls.reloadUI + 1
	end or nil
	G.C_UI = w.reload.c and {
		Reload = function()
			w.calls.cReload = w.calls.cReload + 1
		end,
	} or nil
end

-- Start builds a fresh world, applies setup, runs saved (SavedVariables text
-- from an earlier session, or nil), loads the addon, and fires ADDON_LOADED.
-- It returns the addon's private table.
local function Start(setup, saved)
	world = DefaultWorld()
	if setup then
		setup(world)
	end
	OpenGamerMCPDB = nil
	SLASH_OPENGAMERMCPTRANSMIT1 = nil
	InstallStubs()
	if saved then
		assert(loadstring(saved))()
	end
	-- The client passes every file of the addon the same private table.
	local ns = {}
	for _, path in ipairs(ADDON_FILES) do
		local chunk = assert(loadfile(path))
		chunk(ADDON_NAME, ns)
	end
	Fire("ADDON_LOADED", ADDON_NAME)
	return ns
end

-- EnterWorld fires PLAYER_ENTERING_WORLD and runs the first collections.
local function EnterWorld()
	Fire("PLAYER_ENTERING_WORLD", true, false)
	Advance(6)
end

-- Logout fires PLAYER_LOGOUT, writes the SavedVariables file the client would
-- write, and returns OpenGamerMCPDB read back from that file. With out-dir,
-- the file is kept there as name.lua.
local function Logout(name)
	Fire("PLAYER_LOGOUT")
	local text = WriteSavedVariables()
	if outDir and name then
		local f = assert(io.open(outDir .. "/" .. name .. ".lua", "wb"))
		f:write(text)
		f:close()
	end
	return ReadSavedVariables(text)
end

local function Equipped(db, slot)
	for _, item in ipairs(db.state.inventory.equipped) do
		if item.slot == slot then
			return item
		end
	end
	return nil
end

-- Tests ----------------------------------------------------------------------

test("the TOC names the addon, both interface versions, and OpenGamerMCPDB", function()
	eq(TOC_META.Interface, "11509, 16001", "interface versions")
	eq(TOC_META.SavedVariables, "OpenGamerMCPDB", "SavedVariables")
	eq(TOC_META.Title, "Open Gamer MCP", "title")
end)

for _, client in ipairs({ "forever", "era" }) do
	test(client .. ": PLAYER_LOGOUT writes OpenGamerMCPDB in the §6.3 shape", function()
		local setup = client == "era" and Era(function(w)
			-- A name with multi-byte UTF-8, which must survive the file.
			w.char.name = "Zo\195\171la"
		end) or nil
		-- The file of an earlier session, from another character. None of it
		-- is carried over.
		Start(setup, 'OpenGamerMCPDB = { schema = 1, character = { name = "Oldalt" }, stale = true }')
		EnterWorld()
		-- Changes after the last collection reach the file through the
		-- collection at PLAYER_LOGOUT.
		world.loc.x = 0.5
		world.state.combat = true
		local db = Logout(client)
		local era = client == "era"

		eq(Keys(db), "addon_version,captured_at,character,client,schema,state", "top-level keys")
		eq(db.schema, 1, "schema")
		eq(db.addon_version, TOC_META.Version, "addon_version")
		eq(db.captured_at, GetServerTime(), "captured_at is the server time of the logout")

		eq(Keys(db.client), "build,interface,project_id,version", "client facts; season_id is nil and no flavor")
		eq(db.client.project_id, era and 2 or 1, "project_id")
		eq(db.client.version, era and "1.15.9" or "1.60.1", "version")
		eq(db.client.build, era and "69722" or "69893", "build")
		eq(db.client.interface, era and 11509 or 16001, "interface")

		eq(db.character.guid, "Player-0000-00000001", "guid")
		eq(db.character.name, era and "Zo\195\171la" or "Grimble", "name")
		eq(db.character.realm, "Testrealm", "realm")

		local state = db.state
		eq(Keys(state), "character,inventory,location,quests,recent_path,skills", "sections")
		eq(next(state.recent_path), nil, "recent_path is empty")

		local char = state.character
		eq(char.name, db.character.name, "character name")
		eq(char.level, 12, "level")
		eq(char.xp_max, 7600, "xp_max")
		eq(string.format("%.2f", char.xp_percent), "39.47", "xp_percent")
		eq(char.copper, 12345, "copper")
		eq(char.in_combat, true, "in_combat, read at logout")
		eq(char.resting, true, "resting")
		eq(char.dead, false, "dead")
		eq(char.ghost, false, "ghost")

		local loc = state.location
		eq(loc.map_id, 1429, "map_id")
		eq(loc.x, 0.5, "x, read at logout")
		eq(loc.zone, "Test Forest", "zone")
		eq(loc.in_instance, false, "in_instance")
		eq(loc.hearth, "Test Village", "hearth")

		eq(#state.quests, 2, "quests, without the header")
		local quest = state.quests[1]
		eq(quest.id, 100, "quest id")
		eq(quest.description, "Bring the parcel to the smith.", "quest text")
		eq(quest.objectives_text, "Deliver the parcel.", "objectives text")
		eq(quest.objectives[1].num_required, 1, "objective num_required")
		eq(state.quests[2].complete, true, "complete")

		local inventory = state.inventory
		eq(#inventory.items, 2, "bag items, stacks summed")
		eq(inventory.items[1].count, 6, "count")
		eq(inventory.items[1].sell_price, 1, "sell_price")
		eq(inventory.items_pending, 0, "items_pending")
		eq(Equipped(db, "HeadSlot").stats.armor, 41, "armor")
		eq(Equipped(db, "HeadSlot").equip_loc, "INVTYPE_HEAD", "equip_loc")
		local weapon = Equipped(db, "MainHandSlot").stats
		eq(weapon.dps, 5.3, "dps")
		eq(weapon.min_damage, 7, "min_damage")
		eq(weapon.max_damage, 11, "max_damage")
		eq(weapon.speed, 1.7, "speed")

		eq(#state.skills.lines, 3, "skill lines")
		eq(state.skills.lines[1].max_rank, 75, "max_rank")
		eq(state.skills.lines[3].category, "defense", "defense category")
		eq(state.skills.partial, false, "partial")
	end)
end

test("a part that fails at logout keeps its last polled value", function()
	Start(Era(function(w)
		-- A Hardcore realm. The adapter stamps the raw season ID.
		w.season = 3
	end))
	EnterWorld()
	world.questError = true
	world.char.name = nil
	world.loc.x = 0.25
	local db = Logout()
	eq(#db.state.quests, 2, "quests from the last poll")
	eq(db.state.character.name, "Grimble", "character section from the last poll")
	eq(db.character.name, "Grimble", "character key from the last poll")
	eq(db.state.location.x, 0.25, "location read at logout")
	eq(db.client.season_id, 3, "season_id")
end)

test("/transmit reloads the UI and is the only command", function()
	Start()
	eq(Keys(SlashCmdList), "OPENGAMERMCPTRANSMIT", "slash commands")
	eq(SLASH_OPENGAMERMCPTRANSMIT1, "/transmit", "slash")
	SlashCmdList.OPENGAMERMCPTRANSMIT("")
	eq(world.calls.reloadUI, 1, "ReloadUI when it exists")
	eq(world.calls.cReload, 0, "C_UI.Reload not called")

	Start(function(w)
		w.reload.global = false
	end)
	SlashCmdList.OPENGAMERMCPTRANSMIT("")
	eq(world.calls.cReload, 1, "C_UI.Reload when ReloadUI is missing")

	Start(function(w)
		w.reload.global, w.reload.c = false, false
	end)
	SlashCmdList.OPENGAMERMCPTRANSMIT("")
	truthy(string.find(world.chat[#world.chat], "transmit FAILED", 1, true), "failure line")
end)

test("values the client marks secret are left out of the file", function()
	-- Through the collectors: a secret from an API becomes nil.
	for _, setup in ipairs({ false, Era() }) do
		Start(setup or nil)
		world.loc.facing = Secret()
		world.loc.zone = Secret()
		world.char.guid = Secret()
		world.questLog[2].objectives[1].text = Secret()
		world.items[Link(3000, "Test Cap")].stats.ITEM_MOD_AGILITY_SHORT = Secret()
		world.skills[2].rank = Secret()
		EnterWorld()
		-- WriteSavedVariables raises on a secret stub, so this also checks
		-- that none reached the table.
		local db = Logout()
		eq(db.state.location.facing, nil, "secret facing")
		eq(db.state.location.zone, nil, "secret zone")
		eq(db.state.location.subzone, "Test Village", "subzone kept")
		eq(db.character.guid, nil, "secret guid")
		eq(db.state.quests[1].objectives[1].text, nil, "secret objective text")
		eq(db.state.quests[1].objectives[1].num_required, 1, "objective count kept")
		eq(Equipped(db, "HeadSlot").stats.agility, nil, "secret stat")
		eq(Equipped(db, "HeadSlot").stats.armor, 41, "armor kept")
		eq(db.state.skills.lines[1].rank, nil, "secret skill rank")
	end

	-- The guard itself, for a value that got past the collectors.
	local ns = Start()
	local cleaned = ns.Clean({
		kept = 1,
		secret = Secret(),
		list = { 1, Secret(), 3 },
		nan = 0 / 0,
		inf = math.huge,
		secretTable = SecretTable({ a = 1 }),
		fn = print,
		[true] = 1,
		nested = { deep = Secret() },
		empty = {},
	}, 0)
	eq(Keys(cleaned), "empty,kept,list,nested", "kept keys")
	eq(table.concat(cleaned.list, ","), "1,3", "a secret list entry leaves no gap")
	eq(next(cleaned.nested), nil, "nested secret left out")
end)

-- MainChunkLocals returns the most locals the main chunk of source has in
-- scope at one time. Lua 5.1 and LuaJIT refuse to compile a function with more
-- than 200. k unused locals declared in front of the source are in scope
-- everywhere in the main chunk and in no nested function, so the source
-- compiles with k of them exactly when its own peak is at most 200 - k.
local LUA_MAX_LOCALS = 200

local function MainChunkLocals(source, name)
	local function Fits(k)
		local pad = {}
		for i = 1, k do
			pad[i] = "_pad" .. i
		end
		local prefix = k > 0 and "local " .. table.concat(pad, ", ") .. "; " or ""
		local fn, err = loadstring(prefix .. source, name)
		if fn then
			return true
		end
		assert(string.find(err, "local variables", 1, true), err)
		return false
	end
	assert(Fits(0), name .. " does not compile")
	-- Fits(low) holds and Fits(high) does not.
	local low, high = 0, LUA_MAX_LOCALS + 1
	while high - low > 1 do
		local mid = math.floor((low + high) / 2)
		if Fits(mid) then
			low = mid
		else
			high = mid
		end
	end
	return LUA_MAX_LOCALS - low
end

test("every adapter file's main chunk leaves 20 of its 200 locals free", function()
	eq(MainChunkLocals("local a, b = 1, 2; do local c end", "sample"), 3, "the peak of a known chunk")
	for _, path in ipairs(ADDON_FILES) do
		local f = assert(io.open(path, "rb"))
		local source = f:read("*a")
		f:close()
		local file = string.match(path, "[^/]+$")
		local count = MainChunkLocals(source, file)
		truthy(count <= LUA_MAX_LOCALS - 20, file .. " has " .. count .. " main-chunk locals, more than 180")
	end
end)

-- Run ------------------------------------------------------------------------

local failed = 0
for _, t in ipairs(tests) do
	local ok, err = pcall(t.fn)
	if ok then
		print("ok   " .. t.name)
	else
		failed = failed + 1
		print("FAIL " .. t.name .. "\n     " .. tostring(err))
	end
end
print(string.format("%d passed, %d failed", #tests - failed, failed))
if failed > 0 then
	os.exit(1)
end
