-- Section: auction prices ----------------------------------------------------
--
-- The auction house price of a bag item, from the Auctionator addon
-- (docs/architecture.md §6.3). Auctionator is an optional dependency: the TOC
-- names it in OptionalDeps, so the client loads it before this addon when it
-- is installed and enabled. Only its public API, Auctionator.API.v1, is used.
-- AUCTIONATOR_PRICE_DATABASE is never read.
--
-- The API, read from Auctionator's source at version 284, its Classic Era
-- build (Source/API/v1):
--   GetAuctionPriceByItemLink(callerID, link)     copper, or nil
--   GetAuctionAgeByItemLink(callerID, link)       whole days, or nil
--   GetAuctionAgeByItemID(callerID, itemID)       whole days, or nil
--   IsAuctionDataExactByItemLink(callerID, link)  boolean
-- callerID must be a non-empty string, and an argument of the wrong type
-- raises an error. Until Auctionator has set up its database at PLAYER_LOGIN,
-- each function returns nil or false.
--
-- The price is the lowest buyout of one item in the last scan that saw the
-- item. On Classic Era, Auctionator keys gear by item ID and suffix, and
-- falls back to the item ID alone. A fallback price is for the base item with
-- any suffix, and IsAuctionDataExactByItemLink is false for it.
-- GetAuctionAgeByItemLink reads the first key only, so a fallback price has
-- no link age. The age of the item ID is used then.
--
-- Every function is looked up when it is called and runs in pcall. With
-- Auctionator missing, not set up yet, or failing, the item gets no price,
-- nothing is printed, and no error leaves this file.
--
-- A price is cached per item link, like the item details (Items.lua), so an
-- unchanged inventory costs no Auctionator call on the 5-second collection.
-- A link is read again AH_REFRESH_SECONDS after its last read, because a scan
-- changes the prices and fires no event the adapter listens to. In combat no
-- call is made and the cached value stays. The collection at PLAYER_LOGOUT
-- reads every link again, in combat too: its values are the ones the client
-- writes to disk.

local _, ns = ...

local Lookup = ns.Lookup
local ReadString = ns.ReadString
local ReadInteger = ns.ReadInteger
local ReadBoolean = ns.ReadBoolean
local Now = ns.Now

local AUCTIONATOR_API = "Auctionator.API.v1."
local CALLER_ID = "OgreMCP"

-- The client's money cap, in copper. No buyout is above it.
local AH_PRICE_MAX = 2147483647
-- Auctionator counts whole days since a scan last saw the item. It prunes an
-- item's history only when a scan sees the item again, so the age of an item
-- no scan has seen for years is that long. A value above 100 years is not
-- an age.
local AH_AGE_MAX_DAYS = 36500
-- A cached price is read again after this many seconds.
local AH_REFRESH_SECONDS = 60

-- [link] = { ah = table or nil, at = Now() at the read }. A link without a
-- price has an entry too, so it is not asked for on every collection.
local priceCache = {}

-- Ask returns the first value of the Auctionator API function name, called
-- with the caller ID and arg. It returns nil when Auctionator or the function
-- is missing, or the call raises an error.
local function Ask(name, arg)
	local fn = Lookup(AUCTIONATOR_API .. name)
	if type(fn) ~= "function" then
		return nil
	end
	local ok, value = pcall(fn, CALLER_ID, arg)
	if ok then
		return value
	end
	return nil
end

-- ReadPrice asks Auctionator for the ah table of a link, or nil without a
-- price. A price of 0 is no price: Auctionator leaves out auctions without a
-- buyout.
local function ReadPrice(link, itemID)
	local price = ReadInteger(Ask("GetAuctionPriceByItemLink", link), 1, AH_PRICE_MAX)
	if not price then
		return nil
	end
	local age = ReadInteger(Ask("GetAuctionAgeByItemLink", link), 0, AH_AGE_MAX_DAYS)
	itemID = ReadInteger(itemID, 1)
	if not age and itemID then
		age = ReadInteger(Ask("GetAuctionAgeByItemID", itemID), 0, AH_AGE_MAX_DAYS)
	end
	return {
		price_copper = price,
		age_days = age,
		exact = ReadBoolean(Ask("IsAuctionDataExactByItemLink", link)),
		source = "auctionator",
	}
end

-- AuctionPrice returns the ah table of one bag slot, or nil: the slot has no
-- link, the client reports its item as bound, or Auctionator has no price for
-- the link. bound is the container's isBound. Only true counts as bound, so
-- an item whose bound state is unreadable is priced.
--
-- ctx is the state of one inventory collection (Items.lua). The value comes
-- from the cache unless the link has none, its entry is older than
-- AH_REFRESH_SECONDS, or ctx.logout is set. In combat (ctx.inCombat) and not
-- at logout, it always comes from the cache, and a link without an entry
-- gets nil. A link is read at most once per collection.
local function AuctionPrice(link, itemID, bound, ctx)
	link = ReadString(link)
	if not link or ReadBoolean(bound) == true then
		return nil
	end
	local entry = priceCache[link]
	ctx.pricedLinks = ctx.pricedLinks or {}
	if ctx.pricedLinks[link] then
		return entry and entry.ah
	end
	ctx.pricedLinks[link] = true
	local now = Now()
	if not ctx.logout and (ctx.inCombat or (entry and now - entry.at < AH_REFRESH_SECONDS)) then
		return entry and entry.ah
	end
	entry = { ah = ReadPrice(link, itemID), at = now }
	priceCache[link] = entry
	return entry.ah
end

-- ForgetAuctionPrices drops the cached prices of the links this collection
-- did not ask for: they left the bags, or every slot that holds them is
-- bound.
local function ForgetAuctionPrices(ctx)
	local priced = ctx.pricedLinks or {}
	for link in pairs(priceCache) do
		if not priced[link] then
			priceCache[link] = nil
		end
	end
end

-- Read by the files after this one.
ns.AuctionPrice = AuctionPrice
ns.ForgetAuctionPrices = ForgetAuctionPrices
