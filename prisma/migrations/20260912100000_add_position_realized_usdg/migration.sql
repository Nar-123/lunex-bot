-- VALIDATION PHASE -- realized-PnL persistence (the Module 11 gap).
--
-- Position gains `realizedUsdgRaw`: the total USDG (raw) the position's
-- exit actually returned to the wallet, measured from the CONFIRMED
-- receipts of the two exit transactions (ERC20 Transfer logs decoded and
-- summed). Nullable on purpose -- NULL means "not measured" (legacy rows,
-- or a close whose receipts could not be decoded), never a fabricated 0.
--
-- Non-destructive: one ADD COLUMN. Existing CLOSED rows keep NULL and
-- reporting continues to show them as `realizedPnlAvailable: false`, the
-- same honest-unavailable behaviour they already had.

ALTER TABLE "Position" ADD COLUMN "realizedUsdgRaw" TEXT;
