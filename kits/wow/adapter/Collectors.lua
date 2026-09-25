-- Collectors -----------------------------------------------------------------
--
-- Each collector returns one section of OpenGamerMCPDB.state
-- (docs/architecture.md §6.3). The sections carry the fields of the snapshot
-- in bttf/wow-guide@df80260:shared/src/snapshot.ts, named in snake_case like
-- the rest of OpenGamerMCPDB. The interpreter parses them (§6.2); keep the two
-- in step.
--
-- API choices follow bttf/wow-guide@df80260:docs/api-probe.md. Every value is
-- read through the Read* helpers below, which turn a secret value into nil, so
-- a secret never reaches OpenGamerMCPDB. Out-of-range values also become nil.
--
-- The collectors reuse IsSecret, IsSecretTable, PlainField, and Lookup from
-- OpenGamerMCP.lua.

local _, ns = ...

local IsSecret = ns.IsSecret
local IsSecretTable = ns.IsSecretTable
local Lookup = ns.Lookup
local PlainField = ns.PlainField

local COLLECT_INTERVAL = 5
-- Events coalesce into one collection this many seconds after the first.
local COLLECT_DEBOUNCE = 1
-- QUEST_LOG_UPDATE is ignored for this long after the collector changed the
-- quest selection, in case the client fires it on a later frame.
local QUEST_EVENT_GRACE = 0.5
-- Quest text can be empty until the client has loaded the quest, which may
-- take a while after login. An empty fetch is retried after a delay that
-- starts at QUEST_TEXT_RETRY_BASE seconds and doubles up to
-- QUEST_TEXT_RETRY_MAX, which spreads the attempts over about six minutes.
-- After QUEST_TEXT_MAX_ATTEMPTS the quest is not retried until it leaves the
-- log and returns, so empty text can never cause endless selection changes.
local QUEST_TEXT_MAX_ATTEMPTS = 10
local QUEST_TEXT_RETRY_BASE = 5
local QUEST_TEXT_RETRY_MAX = 60
-- Backpack is bag 0; bags 1 to 4 are the equipped bags.
local LAST_BAG = 4

local COLLECT_EVENTS = {
	"PLAYER_ENTERING_WORLD",
	"ZONE_CHANGED",
	"ZONE_CHANGED_NEW_AREA",
	"ZONE_CHANGED_INDOORS",
	"QUEST_LOG_UPDATE",
	"QUEST_ACCEPTED",
	"QUEST_TURNED_IN",
	"PLAYER_LEVEL_UP",
	"PLAYER_XP_UPDATE",
	"PLAYER_MONEY",
	-- BAG_UPDATE fires once per bag, in bursts. BAG_UPDATE_DELAYED fires once
	-- after the burst.
	"BAG_UPDATE_DELAYED",
	"PLAYER_EQUIPMENT_CHANGED",
	"PLAYER_DEAD",
	"PLAYER_ALIVE",
	"PLAYER_UNGHOST",
	-- A skill rank or maximum changed, or a skill was learned or unlearned.
	"SKILL_LINES_CHANGED",
}

local EQUIPMENT_SLOTS = {
	"HeadSlot",
	"NeckSlot",
	"ShoulderSlot",
	"BackSlot",
	"ChestSlot",
	"ShirtSlot",
	"TabardSlot",
	"WristSlot",
	"HandsSlot",
	"WaistSlot",
	"LegsSlot",
	"FeetSlot",
	"Finger0Slot",
	"Finger1Slot",
	"Trinket0Slot",
	"Trinket1Slot",
	"MainHandSlot",
	"SecondaryHandSlot",
	"RangedSlot",
}

-- Frames that show quest details. While one is visible, changing the quest
-- selection would change what the player sees, so text fetches that select
-- wait.
local QUEST_LOG_FRAMES = {
	"QuestLogFrame",
	"QuestLogDetailFrame",
	"QuestMapFrame",
}

-- Value readers --------------------------------------------------------------

local function Readable(v)
	if IsSecret(v) then
		return nil
	end
	return v
end

local function ReadString(v)
	v = Readable(v)
	if type(v) == "string" then
		return v
	end
	return nil
end

-- ReadName is ReadString that also turns an empty string into nil.
local function ReadName(v)
	v = ReadString(v)
	if v ~= "" then
		return v
	end
	return nil
end

-- ReadNumber returns a finite, non-secret number within [min, max], else nil.
local function ReadNumber(v, min, max)
	v = Readable(v)
	if type(v) ~= "number" or v ~= v or v == math.huge or v == -math.huge then
		return nil
	end
	if (min and v < min) or (max and v > max) then
		return nil
	end
	return v
end

local function ReadInteger(v, min, max)
	v = ReadNumber(v, min, max)
	if v and v == math.floor(v) then
		return v
	end
	return nil
end

local function ReadBoolean(v)
	v = Readable(v)
	if type(v) == "boolean" then
		return v
	end
	return nil
end

local function ReadTable(v)
	if type(v) ~= "table" or IsSecret(v) or IsSecretTable(v) then
		return nil
	end
	return v
end

-- Api calls the global at path, or returns nil when the client lacks it.
-- Errors propagate, so an API that throws fails its section.
local function Api(path, ...)
	local fn = Lookup(path)
	if type(fn) ~= "function" then
		return nil
	end
	return fn(...)
end

-- ApiEither calls the C_ form when the client has it and the global form
-- otherwise. WoW Forever ships only the C_ quest APIs and Classic Era ships
-- only the globals (bttf/wow-guide@df80260:docs/api-probe.md). The choice is
-- made by function existence, never by a client check. It is for pairs with
-- the same arguments and returns.
local function ApiEither(cPath, globalPath, ...)
	if type(Lookup(cPath)) == "function" then
		return Api(cPath, ...)
	end
	return Api(globalPath, ...)
end

-- Item links carry the item name in brackets. Unlike C_Item.GetItemInfo, they
-- do not depend on the client's item cache.
local function NameFromLink(link)
	if type(link) ~= "string" then
		return nil
	end
	local name = string.match(link, "%[(.-)%]")
	if name ~= "" then
		return name
	end
	return nil
end

local function Now()
	return ReadNumber(Api("GetTime")) or 0
end

-- Section: character ---------------------------------------------------------

local function CollectCharacter()
	local name = ReadName(Api("UnitName", "player"))
	local realm = ReadName(Api("GetRealmName"))
	if not name or not realm then
		-- Both identify the character, so write no character rather than half
		-- of one.
		error("player name or realm unreadable", 0)
	end

	local char = { name = name, realm = realm }
	char.class = ReadName((Api("UnitClass", "player")))
	char.race = ReadName((Api("UnitRace", "player")))
	char.faction = ReadName((Api("UnitFactionGroup", "player")))
	-- The level the client reports, with no cap: the cap differs by flavor.
	char.level = ReadInteger(Api("UnitLevel", "player"), 1)
	char.xp = ReadInteger(Api("UnitXP", "player"), 0)
	char.xp_max = ReadInteger(Api("UnitXPMax", "player"), 0)
	if char.xp and char.xp_max and char.xp_max > 0 then
		char.xp_percent = math.min(char.xp / char.xp_max * 100, 100)
	end
	-- nil when the player has no rested XP.
	char.rested_xp = ReadNumber(Api("GetXPExhaustion"), 0)
	char.copper = ReadInteger(Api("GetMoney"), 0)
	char.in_combat = ReadBoolean(Api("UnitAffectingCombat", "player"))
	-- In an inn or a city, accruing rested XP.
	char.resting = ReadBoolean(Api("IsResting"))
	char.dead = ReadBoolean(Api("UnitIsDead", "player"))
	char.ghost = ReadBoolean(Api("UnitIsGhost", "player"))
	return char
end

-- Section: location ----------------------------------------------------------
--
-- zone is the name of the zone map that map_id lies in, read with
-- C_Map.GetMapInfo, which both clients have
-- (bttf/wow-guide@df80260:docs/api-probe.md). The map decides because
-- GetRealZoneText can briefly name a building while the map ID stays the same
-- (bttf/wow-guide@df80260:addon/Storage.lua, ZoneChanged). In Classic Era it
-- named the inn at a login inside one (RED-290). A zone map is a map of type
-- Zone. A micro map, such as a mine, is part of the zone of its parent map,
-- so its zone is the parent's. Where no zone map is found, as on a dungeon or
-- continent map, in an instance, or when the map info is unreadable, zone is
-- GetRealZoneText().

local ZONE_MAP = {
	-- Enum.UIMapType values (MapConstantsDocumentation.lua in
	-- Ketho/wow-ui-source-vanilla, branch classic_era, and in
	-- Ketho/wow-ui-source-forever).
	ZONE = 3,
	MICRO = 5,
	-- Most maps read for one zone name, which stops a loop of parents.
	MAX_READS = 5,
}

-- ZoneName returns the name of the zone map that mapID is or lies in, or nil
-- when there is none or it is unreadable.
local function ZoneName(mapID)
	for _ = 1, ZONE_MAP.MAX_READS do
		local info = mapID and ReadTable(Api("C_Map.GetMapInfo", mapID))
		local mapType = ReadInteger(PlainField(info, "mapType"))
		if mapType == ZONE_MAP.ZONE then
			return ReadName(PlainField(info, "name"))
		elseif mapType ~= ZONE_MAP.MICRO then
			return nil
		end
		mapID = ReadInteger(PlainField(info, "parentMapID"), 1)
	end
	return nil
end

local function CollectLocation()
	local loc = {}
	loc.map_id = ReadInteger(Api("C_Map.GetBestMapForUnit", "player"), 0)
	if loc.map_id then
		-- nil inside instances.
		local pos = ReadTable(Api("C_Map.GetPlayerMapPosition", loc.map_id, "player"))
		if pos then
			local getXY = PlainField(pos, "GetXY")
			local x, y
			if type(getXY) == "function" then
				x, y = getXY(pos)
			else
				x, y = PlainField(pos, "x"), PlainField(pos, "y")
			end
			x, y = ReadNumber(x, 0, 1), ReadNumber(y, 0, 1)
			if x and y then
				loc.x, loc.y = x, y
			end
		end
	end
	loc.zone = ZoneName(loc.map_id) or ReadString(Api("GetRealZoneText"))
	loc.subzone = ReadString(Api("GetSubZoneText"))
	loc.facing = ReadNumber(Api("GetPlayerFacing"), 0, 2 * math.pi)
	loc.in_instance = ReadBoolean((Api("IsInInstance")))
	-- The hearthstone bind point.
	loc.hearth = ReadString(Api("GetBindLocation"))
	return loc
end

-- Section: quests ------------------------------------------------------------
--
-- Quest description text never changes for a quest. It is cached by quest ID
-- for the session and fetched only for quests not yet cached. Entries are
-- dropped when their quest leaves the log. Objectives change, so they are
-- read every time; C_QuestLog.GetQuestObjectives needs no selection.
--
-- GetQuestLogQuestText(logIndex) reads the quest at logIndex. WoW Forever's
-- own UI calls it that way (QuestMapFrame.lua in Ketho/wow-ui-source-forever),
-- so the collector reads text there without touching the quest log
-- selection. The Classic Era UI only ever calls it with no argument, after
-- SelectQuestLogEntry (QuestLogFrame.lua in Ketho/wow-ui-source-vanilla,
-- branch classic_era). Probe version 2 saw Era honour the index as well
-- (bttf/wow-guide@df80260:docs/api-probe.md), but the source does not confirm
-- it, so on Era the collector still selects each quest and restores the
-- previous selection.

-- [questID] = { description = string?, objectivesText = string?, attempts = n }
local questTextCache = {}

local function QuestLogVisible()
	for _, frameName in ipairs(QUEST_LOG_FRAMES) do
		local frame = Lookup(frameName)
		if type(frame) == "table" then
			local isVisible = PlainField(frame, "IsVisible")
			if type(isVisible) == "function" then
				local ok, visible = pcall(isVisible, frame)
				if ok and Readable(visible) then
					return true
				end
			end
		end
	end
	return false
end

local function NeedsText(questID, now)
	local cached = questTextCache[questID]
	if not cached then
		return true
	end
	if cached.description or cached.attempts >= QUEST_TEXT_MAX_ATTEMPTS then
		return false
	end
	return now >= cached.retryAt
end

-- Selecting a quest was never probed in combat, so text fetches that select
-- wait for it to end. An unreadable answer counts as in combat.
local function InCombat()
	local fn = Lookup("InCombatLockdown")
	if type(fn) ~= "function" then
		return false
	end
	local ok, inCombat = pcall(fn)
	return not ok or ReadBoolean(inCombat) ~= false
end

-- QuestSelection returns how the client reads quest text. WoW Forever, which
-- has the C_QuestLog quest log, reads by index and needs no selection:
-- { byIndex = true }. Classic Era selects by log index through the globals:
-- read returns the selection, select takes a pending entry, and restore takes
-- the value that read returned. nil when the client has neither form.
local function QuestSelection()
	if type(Lookup("C_QuestLog.GetInfo")) == "function" then
		return { byIndex = true }
	end
	local getSelection = Lookup("GetQuestLogSelection")
	local selectEntry = Lookup("SelectQuestLogEntry")
	if type(getSelection) == "function" and type(selectEntry) == "function" then
		return {
			read = getSelection,
			select = function(entry)
				selectEntry(entry.logIndex)
			end,
			restore = selectEntry,
		}
	end
	return nil
end

-- ReadQuestTexts reads the text of each pending quest into the cache, calling
-- selectEntry first when it is given. It raises on the first failed call.
local function ReadQuestTexts(pending, getText, now, selectEntry)
	for _, entry in ipairs(pending) do
		local cached = questTextCache[entry.questID]
		if not cached then
			cached = { attempts = 0 }
			questTextCache[entry.questID] = cached
		end
		cached.attempts = cached.attempts + 1
		-- Set before the fetch, so an error also waits before the retry.
		cached.retryAt = now + math.min(
			QUEST_TEXT_RETRY_BASE * 2 ^ (cached.attempts - 1), QUEST_TEXT_RETRY_MAX)
		if selectEntry then
			selectEntry(entry)
		end
		local description, objectivesText = getText(entry.logIndex)
		cached.description = ReadName(description)
		cached.objectivesText = ReadString(objectivesText)
	end
end

-- FetchQuestTexts reads the text of each pending quest. On Era it selects
-- each quest and restores the previous selection on every path, and it
-- changes the selection only when the previous one can be read back, the
-- quest log is closed, and the player is out of combat. A quest whose text
-- was not read has no description; it never fails the quests section. It
-- sets status.selectionChanged when it changed the selection.
local function FetchQuestTexts(pending, status, now)
	if #pending == 0 then
		return
	end
	local selection = QuestSelection()
	local getText = Lookup("GetQuestLogQuestText")
	if not selection or type(getText) ~= "function" then
		return
	end
	if selection.byIndex then
		pcall(ReadQuestTexts, pending, getText, now)
		return
	end
	if QuestLogVisible() or InCombat() then
		return
	end
	local readOk, previous = pcall(selection.read)
	previous = readOk and ReadInteger(previous, 0) or nil
	if not previous then
		return
	end

	status.selectionChanged = true
	pcall(ReadQuestTexts, pending, getText, now, selection.select)
	pcall(selection.restore, previous)
end

-- nil when the API returns nothing readable; an empty table when the quest
-- has no objectives.
local function CollectObjectives(questID)
	local objectives = ReadTable(Api("C_QuestLog.GetQuestObjectives", questID))
	if not objectives then
		return nil
	end
	local out = {}
	for i = 1, #objectives do
		local o = ReadTable(objectives[i])
		if o then
			out[#out + 1] = {
				text = ReadString(PlainField(o, "text")),
				type = ReadString(PlainField(o, "type")),
				finished = ReadBoolean(PlainField(o, "finished")),
				num_fulfilled = ReadInteger(PlainField(o, "numFulfilled"), 0),
				num_required = ReadInteger(PlainField(o, "numRequired"), 0),
			}
		end
	end
	return out
end

-- QuestLogRow returns questID, title, and level for a quest row. It returns
-- nil for a header row, a hidden row, and a row with no readable quest ID.
local function QuestLogRow(index)
	if type(Lookup("C_QuestLog.GetInfo")) == "function" then
		local info = ReadTable(Api("C_QuestLog.GetInfo", index))
		-- Header rows carry questID 0, which the lower bound of 1 rejects.
		local questID = ReadInteger(PlainField(info, "questID"), 1)
		if not questID or PlainField(info, "isHeader") == true or PlainField(info, "isHidden") == true then
			return nil
		end
		return questID, ReadString(PlainField(info, "title")), ReadInteger(PlainField(info, "level"))
	end
	-- GetQuestLogTitle returns title, level, questTag, isHeader, isCollapsed,
	-- isComplete, frequency, questID, startEvent, displayQuestID, isOnMap,
	-- hasLocalPOI, isTask, isBounty, isStory, isHidden, isScaling
	-- (QuestLogFrame.lua in Ketho/wow-ui-source-vanilla, branch classic_era).
	-- Header rows carry questID 0 here too. Position 6 disagreed with
	-- IsQuestComplete in the Era probe, so it is not used. The Era UI reads
	-- isHidden and never acts on it, and the probe saw no row with it set, so
	-- only an explicit true hides a row.
	local title, level, _, isHeader, _, _, _, questID, _, _, _, _, _, _, _, isHidden = Api("GetQuestLogTitle", index)
	questID = ReadInteger(questID, 1)
	if not questID or Readable(isHeader) == true or Readable(isHidden) == true then
		return nil
	end
	return questID, ReadString(title), ReadInteger(level)
end

-- CollectQuests returns { entries = the quests in log order, partial = true
-- when the log was not fully read }.
local function CollectQuests(status)
	-- The first return counts log rows including headers; the second counts
	-- quests. In a Classic-style log the rows may exclude quests under a
	-- collapsed header, which this collector does not expand because that
	-- would change the player's UI. A shortfall sets partial.
	local numEntries, numQuests = ApiEither("C_QuestLog.GetNumQuestLogEntries", "GetNumQuestLogEntries")
	numEntries = ReadInteger(numEntries, 0)
	numQuests = ReadInteger(numQuests, 0)
	if not numEntries then
		error("quest log size unreadable", 0)
	end

	local now = Now()
	local quests, pending, present = {}, {}, {}
	for index = 1, numEntries do
		local questID, title, level = QuestLogRow(index)
		if questID and not present[questID] then
			present[questID] = true
			quests[#quests + 1] = {
				id = questID,
				title = title,
				level = level,
				objectives = CollectObjectives(questID),
				complete = ReadBoolean(ApiEither("C_QuestLog.IsComplete", "IsQuestComplete", questID)),
			}
			if NeedsText(questID, now) then
				pending[#pending + 1] = { questID = questID, logIndex = index }
			end
		end
	end

	-- An unreadable total cannot confirm that every quest was seen.
	local complete = numQuests ~= nil and #quests == numQuests

	-- A quest missing from the rows may only be hidden under a collapsed
	-- header. Its text is dropped only when every quest was seen, or when the
	-- client confirms the player is no longer on it.
	for questID in pairs(questTextCache) do
		if not present[questID] then
			local gone = complete
			if not gone then
				local ok, onQuest = pcall(Api, "C_QuestLog.IsOnQuest", questID)
				gone = ok and ReadBoolean(onQuest) == false
			end
			if gone then
				questTextCache[questID] = nil
			end
		end
	end

	FetchQuestTexts(pending, status, now)
	for _, quest in ipairs(quests) do
		local cached = questTextCache[quest.id]
		if cached then
			quest.description = cached.description
			quest.objectives_text = cached.objectivesText
		end
	end
	return { entries = quests, partial = not complete }
end

-- Section: skills ------------------------------------------------------------
--
-- The lines of the Skills tab: professions, secondary skills, weapon skills,
-- Defense, and the rest, each under a header row. Classic Era has the globals
-- GetNumSkillLines and GetSkillLineInfo(index), which returns skillName,
-- isHeader, isExpanded, skillRank, numTempPoints, skillModifier, skillMaxRank,
-- and more (Ketho/wow-ui-source-vanilla, SkillFrame.lua). WoW Forever has
-- C_SkillInfo.GetNumSkillLines and C_SkillInfo.GetSkillLineInfo(index), which
-- returns a table with a category ID and a skill ID
-- (Ketho/wow-ui-source-forever, SkillInfoDocumentation.lua). The C_ form is
-- used when it exists.
--
-- The collector never expands or collapses a header, because that would
-- change the player's UI. The count and the rows leave out the lines under a
-- collapsed header, so a collapsed header makes the list partial.

local SKILLS = {
	-- The bounds of skillsSchema in
	-- bttf/wow-guide@df80260:shared/src/snapshot.ts.
	MAX = 100,
	NAME_MAX = 60,
	RANK_MAX = 1000,
	-- Rows read at most, headers included.
	MAX_ROWS = 200,
	-- skillLineCategoryID in Forever. A header row's skillID is its category.
	CATEGORY_IDS = { [6] = "weapon", [7] = "class", [8] = "armor", [9] = "secondary", [10] = "language", [11] = "profession" },
	-- Era gives no category ID, so the header's name says it. The names are
	-- the English client's. Under any other header a line is "other".
	CATEGORY_HEADERS = {
		["Professions"] = "profession",
		["Secondary Skills"] = "secondary",
		["Weapon Skills"] = "weapon",
		["Class Skills"] = "class",
		["Armor Proficiencies"] = "armor",
		["Languages"] = "language",
	},
	-- Defense is listed with the weapon skills and gets a category of its own.
	DEFENSE_ID = 95,
	DEFENSE_NAME = "Defense",
}

-- SkillName returns a name within SKILLS.NAME_MAX bytes, else nil.
local function SkillName(v)
	v = ReadName(v)
	if v and #v <= SKILLS.NAME_MAX then
		return v
	end
	return nil
end

-- Truthy reads a flag that may be a boolean or 1 and nil. A secret reads as nil.
local function Truthy(v)
	v = Readable(v)
	return v ~= nil and v ~= false
end

-- SkillRow returns one row of the list as a table, or nil when it is
-- unreadable. collapsed is true for a header whose lines are hidden; an
-- unreadable expanded flag counts as collapsed.
local function SkillRow(index)
	if type(Lookup("C_SkillInfo.GetSkillLineInfo")) == "function" then
		local info = ReadTable(Api("C_SkillInfo.GetSkillLineInfo", index))
		if not info then
			return nil
		end
		return {
			name = SkillName(PlainField(info, "name")),
			isHeader = ReadBoolean(PlainField(info, "isHeader")) == true,
			collapsed = ReadBoolean(PlainField(info, "isCollapsed")) ~= false,
			rank = PlainField(info, "rank"),
			maxRank = PlainField(info, "maxRank"),
			modifier = PlainField(info, "modifier"),
			skillID = ReadInteger(PlainField(info, "skillID")),
			categoryID = ReadInteger(PlainField(info, "skillLineCategoryID")),
			-- Forever lists sub-lines under their parent; the Skills tab
			-- shows only lines whose parent is 0.
			isChild = (ReadInteger(PlainField(info, "parentSkillLineID")) or 0) ~= 0,
		}
	end
	local name, isHeader, isExpanded, rank, _, modifier, maxRank = Api("GetSkillLineInfo", index)
	return {
		name = SkillName(name),
		isHeader = Truthy(isHeader),
		collapsed = not Truthy(isExpanded),
		rank = rank,
		maxRank = maxRank,
		modifier = modifier,
	}
end

local function SkillCategory(row, header)
	if row.skillID == SKILLS.DEFENSE_ID or (row.skillID == nil and row.name == SKILLS.DEFENSE_NAME) then
		return "defense"
	end
	return SKILLS.CATEGORY_IDS[row.categoryID or -1] or (header and header.category) or "other"
end

local function CollectSkills()
	local numRows = ReadInteger(ApiEither("C_SkillInfo.GetNumSkillLines", "GetNumSkillLines"), 0)
	if not numRows then
		error("skill list size unreadable", 0)
	end

	local lines, partial = {}, false
	local header
	for index = 1, math.min(numRows, SKILLS.MAX_ROWS) do
		local row = SkillRow(index)
		if not row then
			partial = true
		elseif row.isHeader then
			if row.collapsed then
				partial = true
			end
			header = {
				name = row.name,
				category = SKILLS.CATEGORY_IDS[row.skillID or -1] or SKILLS.CATEGORY_HEADERS[row.name or ""],
			}
		elseif row.isChild then
			-- Not a line of the Skills tab.
		elseif not row.name then
			-- A line needs a name, so a line without one is left out.
			partial = true
		else
			if #lines >= SKILLS.MAX then
				partial = true
				break
			end
			lines[#lines + 1] = {
				name = row.name,
				category = SkillCategory(row, header),
				header = header and header.name,
				rank = ReadInteger(row.rank, 0, SKILLS.RANK_MAX),
				max_rank = ReadInteger(row.maxRank, 0, SKILLS.RANK_MAX),
				modifier = ReadInteger(row.modifier, -SKILLS.RANK_MAX, SKILLS.RANK_MAX),
			}
		end
	end
	if numRows > SKILLS.MAX_ROWS then
		partial = true
	end
	return { lines = lines, partial = partial }
end

-- Read by the files after this one.
ns.COLLECT_INTERVAL = COLLECT_INTERVAL
ns.COLLECT_DEBOUNCE = COLLECT_DEBOUNCE
ns.QUEST_EVENT_GRACE = QUEST_EVENT_GRACE
ns.LAST_BAG = LAST_BAG
ns.COLLECT_EVENTS = COLLECT_EVENTS
ns.EQUIPMENT_SLOTS = EQUIPMENT_SLOTS
ns.ReadString = ReadString
ns.ReadName = ReadName
ns.ReadNumber = ReadNumber
ns.ReadInteger = ReadInteger
ns.ReadBoolean = ReadBoolean
ns.ReadTable = ReadTable
ns.Api = Api
ns.ApiEither = ApiEither
ns.NameFromLink = NameFromLink
ns.Now = Now
ns.CollectCharacter = CollectCharacter
ns.ZoneName = ZoneName
ns.CollectLocation = CollectLocation
ns.InCombat = InCombat
ns.CollectQuests = CollectQuests
ns.CollectSkills = CollectSkills
