-- Section: item details ------------------------------------------------------
--
-- Details of one item: quality, levels, equip location, type, sell price,
-- stats, and the text of its random suffix and its enchant. Every field is
-- optional. A missing API, a nil return for an item the client has not cached,
-- a secret value, and an error all leave the field out, and never fail the
-- inventory section.
--
-- API choice, by function existence:
--   item info   C_Item.GetItemInfo, else GetItemInfo
--   stats       C_Item.GetItemStats, else GetItemStats. The table is keyed by
--               the names of global strings (RESISTANCE0_NAME is armor).
--   damage and speed of a weapon, which the stats table lacks:
--               C_TooltipInfo.GetHyperlink when the client has it. It returns
--               data and touches no frame. Otherwise a hidden tooltip that
--               belongs to the addon, filled with SetHyperlink. GameTooltip is
--               never touched, and neither call is protected. The texts are
--               matched against the client's own format strings
--               (DAMAGE_TEMPLATE, SPEED), so the match follows the locale.
--   suffix and enchant text (docs/architecture.md §6.3). The stats API
--               returns the base item's stats, on a full link too, so a
--               random suffix ("of the Bear") and an enchant are not in the
--               stats table. The same tooltip read gives them: the link's
--               tooltip is compared with the tooltip of the link without its
--               suffix ID, and with the tooltip of the link without its
--               enchant ID. The lines that only the full link has are the
--               suffix's lines or the enchant's line. They are stored as
--               text. The interpreter reads the numbers out of them (§10.4).
--
-- Details are cached per item link for the session. A link encodes the item
-- with its enchant and random suffix, so the details of a link never change.
-- An unchanged inventory therefore costs no item API call and no tooltip scan
-- on the 5-second collection. BAG_UPDATE_DELAYED and PLAYER_EQUIPMENT_CHANGED
-- mark the cache stale: the next collection drops the links that are gone and
-- retries the entries that are incomplete. GET_ITEM_INFO_RECEIVED and the end
-- of combat do the same when an entry is waiting. Tooltips are not read in
-- combat, and at most ITEM_TOOLTIP_SCANS_PER_COLLECTION per collection. An
-- item with a suffix and an enchant takes three of them.

local _, ns = ...

local IsSecret = ns.IsSecret
local Lookup = ns.Lookup
local PlainField = ns.PlainField
local LAST_BAG = ns.LAST_BAG
local EQUIPMENT_SLOTS = ns.EQUIPMENT_SLOTS
local ReadString = ns.ReadString
local ReadName = ns.ReadName
local ReadNumber = ns.ReadNumber
local ReadInteger = ns.ReadInteger
local ReadTable = ns.ReadTable
local Api = ns.Api
local NameFromLink = ns.NameFromLink
local InCombat = ns.InCombat

-- The item APIs, each list in order of preference. The first form the client
-- has is used. Adjust these lists when a probe shows another form
-- (bttf/wow-guide@df80260:docs/api-probe.md, "Probe version 5").
--
-- Classic Era 1.15.9 (probe version 5, 2026-09-19): both item info forms
-- exist with identical returns, so C_Item.GetItemInfo is used. Only the
-- global GetItemStats exists. C_TooltipInfo is missing, so damage and speed
-- come from the hidden tooltip with SetHyperlink. WoW Forever is not probed
-- yet.
local ITEM_INFO_APIS = { "C_Item.GetItemInfo", "GetItemInfo" }
local ITEM_STATS_APIS = { "C_Item.GetItemStats", "GetItemStats" }
local ITEM_TOOLTIP_DATA_APIS = { "C_TooltipInfo.GetHyperlink" }

local function FirstApi(paths)
	for _, path in ipairs(paths) do
		local fn = Lookup(path)
		if type(fn) == "function" then
			return fn
		end
	end
	return nil
end

-- An entry whose item info stays unreadable is tried this many times. After
-- that it is left alone until its link leaves the inventory and comes back,
-- so a link the client never resolves cannot cause endless calls.
local ITEM_DETAIL_MAX_ATTEMPTS = 5

-- The bounds of bttf/wow-guide@df80260:shared/src/snapshot.ts.
local ITEM_TEXT_MAX_LENGTH = 60
local ITEM_STATS_MAX_KEYS = 24
local ITEM_STATS_KEY_MAX_LENGTH = 40
local ITEM_STAT_MAX = 1000000
local ITEM_SELL_PRICE_MAX = 2147483647
local ITEM_TOOLTIP_SCANS_PER_COLLECTION = 8
local ITEM_TOOLTIP_MAX_LINES = 30
local ITEMS_PENDING_MAX = 1000
-- A longer link is left out. A Classic Era item link is about 100 bytes.
local ITEM_LINK_MAX_LENGTH = 400
-- The longest tooltip line kept as suffix or enchant text, and the most lines
-- kept for one suffix. The interpreter has the same bounds (schema.ts).
local ITEM_TOOLTIP_TEXT_MAX_LENGTH = 120
local ITEM_SUFFIX_MAX_LINES = 8
-- The fields of an item string that hold the enchant ID and the suffix ID.
-- Field 1 is the item ID.
local LINK_FIELDS = { enchant = 2, suffix = 7 }

local ITEM_STAT_KEYS = {
	RESISTANCE0_NAME = "armor",
	RESISTANCE1_NAME = "holy_resistance",
	RESISTANCE2_NAME = "fire_resistance",
	RESISTANCE3_NAME = "nature_resistance",
	RESISTANCE4_NAME = "frost_resistance",
	RESISTANCE5_NAME = "shadow_resistance",
	RESISTANCE6_NAME = "arcane_resistance",
	ITEM_MOD_DAMAGE_PER_SECOND_SHORT = "dps",
	ITEM_MOD_STRENGTH_SHORT = "strength",
	ITEM_MOD_AGILITY_SHORT = "agility",
	ITEM_MOD_STAMINA_SHORT = "stamina",
	ITEM_MOD_INTELLECT_SHORT = "intellect",
	ITEM_MOD_SPIRIT_SHORT = "spirit",
}

-- Equip locations whose items have damage and speed.
local WEAPON_EQUIP_LOCS = {
	INVTYPE_WEAPON = true,
	INVTYPE_2HWEAPON = true,
	INVTYPE_WEAPONMAINHAND = true,
	INVTYPE_WEAPONOFFHAND = true,
	INVTYPE_RANGED = true,
	INVTYPE_RANGEDRIGHT = true,
	INVTYPE_THROWN = true,
}

-- [link] = { details = table or nil, pending = "info", "tooltip", "error", or nil,
--            attempts = n, gaveUp = true or nil, textPending = true or nil }
-- textPending marks an entry whose suffix or enchant text waits for a tooltip
-- read.
local itemDetailCache = {}
local itemCacheStale = true
local itemsPending = 0

-- ReadText is ReadName with a length bound of ITEM_TEXT_MAX_LENGTH bytes.
local function ReadText(v)
	v = ReadName(v)
	if v and #v <= ITEM_TEXT_MAX_LENGTH then
		return v
	end
	return nil
end

-- StatKey turns a key of the stats table into the stored key: a known name,
-- or the lower case of an ITEM_MOD_ name without _SHORT
-- (ITEM_MOD_CRIT_RATING_SHORT becomes crit_rating). Other keys (sockets) give
-- nil.
local function StatKey(raw)
	local known = ITEM_STAT_KEYS[raw]
	if known then
		return known, true
	end
	local body = string.match(raw, "^ITEM_MOD_([A-Z0-9_]+)$")
	if not body then
		return nil
	end
	body = string.gsub(body, "_SHORT$", "")
	local key = string.gsub(string.lower(body), "_+", "_")
	if #key > ITEM_STATS_KEY_MAX_LENGTH or not string.find(key, "^[a-z][a-z0-9_]*[a-z0-9]$") then
		return nil
	end
	return key, false
end

local function RoundStat(v)
	return math.floor(v * 100 + 0.5) / 100
end

-- ReadItemStats returns the normalised stats of a link, or nil. Known keys
-- win when the table holds more than ITEM_STATS_MAX_KEYS.
local function ReadItemStats(link)
	local getStats = FirstApi(ITEM_STATS_APIS)
	if not getStats then
		return nil
	end
	local ok, raw = pcall(getStats, link)
	raw = ok and ReadTable(raw) or nil
	if not raw then
		return nil
	end
	local found = {}
	pcall(function()
		for k, v in pairs(raw) do
			if not IsSecret(k) and type(k) == "string" then
				local key, known = StatKey(k)
				local value = ReadNumber(v, -ITEM_STAT_MAX, ITEM_STAT_MAX)
				if key and value then
					found[#found + 1] = { key = key, value = RoundStat(value), known = known }
				end
			end
		end
	end)
	table.sort(found, function(a, b)
		if a.known ~= b.known then
			return a.known
		end
		return a.key < b.key
	end)
	local stats
	for i = 1, math.min(#found, ITEM_STATS_MAX_KEYS) do
		stats = stats or {}
		stats[found[i].key] = stats[found[i].key] or found[i].value
	end
	return stats
end

-- Created on first use and reused; frames cannot be destroyed. false when the
-- client cannot create it.
--
-- SetHyperlink closes a tooltip that already shows the same link
-- (warcraft.wiki.gg, GameTooltip:SetHyperlink). Each read hides the tooltip
-- afterwards, and the reads of one item all use different links.
local scanTooltip

local function HiddenTooltipLines(link)
	if scanTooltip == nil then
		scanTooltip = false
		local ok, frame = pcall(CreateFrame, "GameTooltip", "OgreMCPScanTooltip", nil, "GameTooltipTemplate")
		if ok and type(frame) == "table" and type(frame.SetHyperlink) == "function"
			and type(frame.NumLines) == "function" then
			scanTooltip = frame
		end
	end
	local tip = scanTooltip
	if not tip then
		return nil
	end
	local lines
	pcall(function()
		tip:SetOwner(Lookup("WorldFrame") or Lookup("UIParent"), "ANCHOR_NONE")
		tip:ClearLines()
		tip:SetHyperlink(link)
		local count = ReadInteger(tip:NumLines(), 0) or 0
		lines = {}
		for i = 1, math.min(count, ITEM_TOOLTIP_MAX_LINES) do
			local line = {}
			for side, field in pairs({ Left = "left", Right = "right" }) do
				local region = Lookup("OgreMCPScanTooltipText" .. side .. i)
				if type(region) == "table" and type(region.GetText) == "function" then
					line[field] = ReadString(region:GetText())
				end
			end
			lines[#lines + 1] = line
		end
	end)
	pcall(function()
		tip:Hide()
	end)
	return lines
end

-- TooltipLines returns the tooltip of a link as { left = string?, right =
-- string? } rows, and the name of the source. Secret texts are left out.
local function TooltipLines(link)
	local getHyperlink = FirstApi(ITEM_TOOLTIP_DATA_APIS)
	if getHyperlink then
		local ok, data = pcall(getHyperlink, link)
		local raw = ok and ReadTable(PlainField(ReadTable(data), "lines")) or nil
		if not raw then
			return nil, "C_TooltipInfo"
		end
		local lines = {}
		for i = 1, math.min(#raw, ITEM_TOOLTIP_MAX_LINES) do
			local line = ReadTable(raw[i])
			lines[#lines + 1] = {
				left = ReadString(PlainField(line, "leftText")),
				right = ReadString(PlainField(line, "rightText")),
			}
		end
		return lines, "C_TooltipInfo"
	end
	local lines = HiddenTooltipLines(link)
	if lines then
		return lines, "hidden tooltip"
	end
	return nil, "none"
end

-- TemplatePattern turns a client format string such as "%s - %s Damage" into
-- an anchored Lua pattern that captures a number for each placeholder.
local function TemplatePattern(template)
	-- Positional placeholders (%1$s) become plain ones. \001 marks a placeholder
	-- while the rest of the text is escaped.
	local text = string.gsub(template, "%%%d+%$", "%%")
	text = string.gsub(text, "%%[sdf]", "\001")
	text = string.gsub(text, "[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0")
	text = string.gsub(text, "\001", "([%%d%%.,]+)")
	return "^" .. text .. "$"
end

-- WeaponNumbers reads minDamage, maxDamage, and speed from tooltip rows.
-- Damage values are whole numbers in the tooltip, so a value that parses to a
-- fraction is a misread thousands separator and is dropped.
local function WeaponNumbers(lines)
	local damagePattern = TemplatePattern(ReadName(Lookup("DAMAGE_TEMPLATE")) or "%s - %s Damage")
	local speedLabel = ReadName(Lookup("SPEED")) or "Speed"
	local speedPattern = "^" .. string.gsub(speedLabel, "[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0") .. "%s+([%d%.,]+)$"
	local minDamage, maxDamage, speed
	for _, line in ipairs(lines) do
		if not minDamage and line.left then
			local low, high = string.match(line.left, damagePattern)
			if low and high then
				low = tonumber((string.gsub(low, ",", "")))
				high = tonumber((string.gsub(high, ",", "")))
				if low and high and low == math.floor(low) and high == math.floor(high) and low >= 0 and low <= high then
					minDamage, maxDamage = low, high
				end
			end
		end
		if not speed then
			for _, text in ipairs({ line.right or "", line.left or "" }) do
				local found = string.match(text, speedPattern)
				-- Some locales write the decimal point as a comma.
				found = found and tonumber((string.gsub(found, ",", ".")))
				if found and found >= 0.1 and found <= 10 then
					speed = found
					break
				end
			end
		end
	end
	return minDamage, maxDamage, speed
end

-- AddWeaponNumbers puts damage and speed from the tooltip into stats. With a
-- dps from the stats API, numbers that disagree with it by more than 15 %
-- are dropped and the API's dps stays: a range and a dps that contradict each
-- other must not reach a consumer together. The floor of 0.1 only absorbs
-- rounding. A floor of 1 let a weapon through whose API dps was 1.25 and whose
-- tooltip read 2 - 5 at speed 1.6, which is 2.19. Which source is right in
-- such a case is not known yet (RED-243).
-- Without an API dps, dps is derived from the tooltip numbers.
local function AddWeaponNumbers(stats, lines)
	local minDamage, maxDamage, speed = WeaponNumbers(lines)
	if not (minDamage and maxDamage and speed) then
		return stats
	end
	local derived = (minDamage + maxDamage) / 2 / speed
	if derived > ITEM_STAT_MAX or maxDamage > ITEM_STAT_MAX then
		return stats
	end
	stats = stats or {}
	if stats.dps then
		if math.abs(derived - stats.dps) > math.max(0.1, stats.dps * 0.15) then
			return stats
		end
	else
		stats.dps = RoundStat(derived)
	end
	stats.min_damage, stats.max_damage, stats.speed = minDamage, maxDamage, RoundStat(speed)
	return stats
end

-- LinkWithout returns link with one field of its item string emptied, which
-- the client reads as 0: Classic Era writes its own zero fields that way. nil
-- when the link has no item string or holds no ID in that field. Only the item
-- string changes, so the link text still names the suffix.
local function LinkWithout(link, field)
	local head, body, tail = string.match(link, "^(.-|Hitem:)([^|]*)(|h.*)$")
	if not body then
		return nil
	end
	local fields = {}
	for value in string.gmatch(body .. ":", "([^:]*):") do
		fields[#fields + 1] = value
	end
	local id = tonumber(fields[field])
	if not id or id == 0 then
		return nil
	end
	fields[field] = ""
	return head .. table.concat(fields, ":") .. tail
end

-- ExtraLines returns the left texts that the rows of full have and the rows
-- of base lack, in the order of full. The first row of each, the item name,
-- is skipped, and so is a blank text. Texts are counted: a text that full has
-- twice and base has once is returned once. nil when base has no row after
-- the name. The client did not fill that tooltip, and every line of full
-- would count as extra.
local function ExtraLines(full, base)
	if not base or #base < 2 then
		return nil
	end
	local counts = {}
	for i = 2, #base do
		local text = base[i].left
		if text then
			counts[text] = (counts[text] or 0) + 1
		end
	end
	local extra = {}
	for i = 2, #full do
		local text = full[i].left
		if text and string.find(text, "%S") then
			if (counts[text] or 0) > 0 then
				counts[text] = counts[text] - 1
			else
				extra[#extra + 1] = text
			end
		end
	end
	return extra
end

-- AddLinkTexts puts suffix_text and enchant_text into details (§6.3). lines
-- are the tooltip rows of the link, and without holds the link without its
-- suffix ID and the link without its enchant ID, each nil when the link has no
-- such ID. Each one given costs one more tooltip read. suffix_text is every
-- line that the suffix adds, and enchant_text is the first line that the
-- enchant adds. A text longer than ITEM_TOOLTIP_TEXT_MAX_LENGTH is left out.
local function AddLinkTexts(details, lines, without)
	if without.suffix then
		local texts = {}
		for _, text in ipairs(ExtraLines(lines, (TooltipLines(without.suffix))) or {}) do
			if #texts < ITEM_SUFFIX_MAX_LINES and #text <= ITEM_TOOLTIP_TEXT_MAX_LENGTH then
				texts[#texts + 1] = text
			end
		end
		details.suffix_text = texts[1] and texts or nil
	end
	if without.enchant then
		local text = (ExtraLines(lines, (TooltipLines(without.enchant))) or {})[1]
		details.enchant_text = text and #text <= ITEM_TOOLTIP_TEXT_MAX_LENGTH and text or nil
	end
end

-- BuildItemDetails fills entry for a link. ctx is the state of one collection.
local function BuildItemDetails(link, entry, ctx)
	entry.pending = nil
	entry.textPending = nil
	local getInfo = FirstApi(ITEM_INFO_APIS)
	if not getInfo then
		-- Nothing to wait for: the client has no item info API.
		entry.details = nil
		return
	end
	-- name, link, quality, itemLevel, minLevel, type, subType, stackCount,
	-- equipLoc, icon, sellPrice.
	local name, _, quality, itemLevel, minLevel, itemType, subType, _, equipLoc, _, sellPrice = getInfo(link)
	-- Until the client has cached the item the call returns no values at all
	-- (Era, probe version 5), which reads as nil here. type() is safe on a
	-- secret value.
	if type(name) == "nil" and type(quality) == "nil" then
		entry.details = nil
		entry.pending = "info"
		return
	end

	local details = {
		quality = ReadInteger(quality, 0, 10),
		type = ReadText(itemType),
		sub_type = ReadText(subType),
		sell_price = ReadInteger(sellPrice, 0, ITEM_SELL_PRICE_MAX),
	}
	entry.details = details
	equipLoc = ReadText(equipLoc)
	-- Current clients give this token to an item that cannot be equipped.
	if not equipLoc or equipLoc == "INVTYPE_NON_EQUIP_IGNORE" then
		return
	end
	details.equip_loc = equipLoc
	details.item_level = ReadInteger(itemLevel, 0, 1000)
	details.min_level = ReadInteger(minLevel, 0, 100)
	-- Kept from an earlier attempt that waited for the tooltip.
	details.stats = entry.stats or ReadItemStats(link)
	entry.stats = details.stats

	-- The tooltip reads this link needs: its own tooltip for a weapon's damage
	-- and speed and as the full side of each comparison, and one more for
	-- each of the suffix ID and the enchant ID it holds. Only an item that can
	-- be equipped has a suffix or an enchant.
	local stats = details.stats
	local weapon = WEAPON_EQUIP_LOCS[equipLoc] and not (stats and stats.min_damage and stats.max_damage and stats.speed)
	local without = { suffix = LinkWithout(link, LINK_FIELDS.suffix), enchant = LinkWithout(link, LINK_FIELDS.enchant) }
	local hasText = (without.suffix or without.enchant) and true or nil
	if not (weapon or hasText) then
		return
	end
	local reads = 1 + (without.suffix and 1 or 0) + (without.enchant and 1 or 0)
	-- A link waits until the budget covers all of its reads, so its texts are
	-- read in one collection or not at all.
	if ctx.inCombat or ctx.tooltipBudget < reads then
		entry.pending = "tooltip"
		entry.textPending = hasText
		ctx.budgetExhausted = ctx.budgetExhausted or not ctx.inCombat
		return
	end
	ctx.tooltipBudget = ctx.tooltipBudget - reads
	-- The tooltip step has its own protected call: an error here keeps
	-- what was read above. The entry is not pending afterwards, so a
	-- tooltip that fails is not read again for this link.
	pcall(function()
		local lines = TooltipLines(link)
		if not lines then
			return
		end
		if weapon then
			local merged = AddWeaponNumbers(stats, lines)
			details.stats = merged
			entry.stats = merged
		end
		AddLinkTexts(details, lines, without)
	end)
end

-- ItemDetails returns the cached details of a link, building them when the
-- link is new, or when the cache is stale and the entry is incomplete.
local function ItemDetails(link, ctx)
	if not link then
		return nil
	end
	ctx.seen[link] = true
	local entry = itemDetailCache[link]
	if entry and not (entry.pending and ctx.retry) then
		return entry.details
	end
	entry = entry or {}
	itemDetailCache[link] = entry
	local ok = pcall(BuildItemDetails, link, entry, ctx)
	-- Details read before an error are kept.
	if not ok and not entry.details then
		entry.pending = "error"
	end
	if entry.pending == "info" or entry.pending == "error" then
		entry.attempts = (entry.attempts or 0) + 1
		if entry.attempts >= ITEM_DETAIL_MAX_ATTEMPTS then
			entry.pending = nil
			entry.gaveUp = true
		end
	end
	return entry.details
end

-- StoredLink returns the link an item carries (§6.3), or nil for an empty or
-- an overlong one.
local function StoredLink(link)
	if link and link ~= "" and #link <= ITEM_LINK_MAX_LENGTH then
		return link
	end
	return nil
end

local function ApplyItemDetails(item, details)
	if not details then
		return
	end
	for k, v in pairs(details) do
		item[k] = v
	end
end

-- Section: inventory ---------------------------------------------------------

local function CollectInventory()
	local ctx = {
		seen = {},
		retry = itemCacheStale,
		inCombat = InCombat(),
		tooltipBudget = ITEM_TOOLTIP_SCANS_PER_COLLECTION,
	}

	-- Stacks of the same item are summed. Items are keyed by ID, or by name
	-- when the ID is unreadable. An item that can be equipped is keyed by its
	-- link: two items with one ID can differ in their random suffix.
	local items, byKey, countUnknown = {}, {}, {}
	for bag = 0, LAST_BAG do
		local numSlots = ReadInteger(Api("C_Container.GetContainerNumSlots", bag), 0) or 0
		for slot = 1, numSlots do
			-- nil for an empty slot.
			local info = ReadTable(Api("C_Container.GetContainerItemInfo", bag, slot))
			if info then
				local itemID = ReadInteger(PlainField(info, "itemID"), 1)
				local link = ReadString(PlainField(info, "hyperlink"))
				local name = ReadName(PlainField(info, "itemName")) or NameFromLink(link)
				local count = ReadInteger(PlainField(info, "stackCount"), 1)
				local details = ItemDetails(link, ctx)
				local key = (details and details.equip_loc and link) or itemID or name
				if key then
					local item = byKey[key]
					if not item then
						item = { item_id = itemID, name = name, count = 0, link = StoredLink(link) }
						ApplyItemDetails(item, details)
						-- The container gives the quality without the item cache.
						item.quality = item.quality or ReadInteger(PlainField(info, "quality"), 0, 10)
						byKey[key] = item
						items[#items + 1] = item
					end
					item.name = item.name or name
					if count then
						item.count = item.count + count
					else
						countUnknown[item] = true
					end
				end
			end
		end
	end
	for item in pairs(countUnknown) do
		item.count = nil
	end

	local equipped = {}
	for _, slotName in ipairs(EQUIPMENT_SLOTS) do
		-- GetInventorySlotInfo errors on a slot name the client does not know.
		local ok, slotID = pcall(Api, "GetInventorySlotInfo", slotName)
		slotID = ok and ReadInteger(slotID, 0) or nil
		if slotID then
			local link = ReadString(Api("GetInventoryItemLink", "player", slotID))
			local itemID = ReadInteger(Api("GetInventoryItemID", "player", slotID), 1)
			if link or itemID then
				local item = { slot = slotName, item_id = itemID, name = NameFromLink(link), link = StoredLink(link) }
				ApplyItemDetails(item, ItemDetails(link, ctx))
				equipped[#equipped + 1] = item
			end
		end
	end

	-- A stale cache drops the links that are gone. It stays stale while
	-- tooltips wait for the next collection's budget.
	if ctx.retry then
		for link in pairs(itemDetailCache) do
			if not ctx.seen[link] then
				itemDetailCache[link] = nil
			end
		end
	end
	itemCacheStale = ctx.budgetExhausted == true
	local pending = 0
	for _, entry in pairs(itemDetailCache) do
		if entry.pending then
			pending = pending + 1
		end
	end
	itemsPending = pending
	-- Links of this inventory whose details were not read: the client had not
	-- cached the item, the read failed, or the client has no item info API.
	-- And links whose suffix or enchant text waits for a tooltip read (§6.3).
	-- A consumer must not take the bag items for complete while this is
	-- above zero.
	local unread = 0
	for link in pairs(ctx.seen) do
		local entry = itemDetailCache[link]
		if not (entry and entry.details) or entry.textPending then
			unread = unread + 1
		end
	end

	return { items = items, equipped = equipped, items_pending = math.min(unread, ITEMS_PENDING_MAX) }
end

local function MarkItemCacheStale()
	itemCacheStale = true
end

local function ItemsPending()
	return itemsPending > 0
end

-- Read by the files after this one.
ns.CollectInventory = CollectInventory
ns.MarkItemCacheStale = MarkItemCacheStale
ns.ItemsPending = ItemsPending
