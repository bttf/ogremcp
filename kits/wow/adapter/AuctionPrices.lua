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

local _, ns = ...

local Lookup = ns.Lookup
local ReadString = ns.ReadString
local ReadInteger = ns.ReadInteger
local ReadBoolean = ns.ReadBoolean

local AUCTIONATOR_API = "Auctionator.API.v1."
local CALLER_ID = "OgreMCP"

-- The client's money cap, in copper. No buyout is above it.
local AH_PRICE_MAX = 2147483647
-- Auctionator counts whole days since a scan last saw the item. It prunes an
-- item's history only when a scan sees the item again, so the age of an item
-- no scan has seen for years is that long. A value above 100 years is not
-- an age.
local AH_AGE_MAX_DAYS = 36500

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

-- AuctionPrice returns the ah table of a bag item, or nil: the item has no
-- link, the client reports it as bound, or Auctionator has no price for it.
-- bound is the container's isBound. Only true counts as bound, so an item
-- whose bound state is unreadable is priced. A price of 0 is no price:
-- Auctionator leaves out auctions without a buyout.
local function AuctionPrice(link, itemID, bound)
	link = ReadString(link)
	if not link or ReadBoolean(bound) == true then
		return nil
	end
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

-- Read by the files after this one.
ns.AuctionPrice = AuctionPrice
