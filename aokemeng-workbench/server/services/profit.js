'use strict';
/**
 * 商品利润计算器（单件维度）。所有金额单位：sen（整数）。费率单位：百分比（如 5.5 表示 5.5%）。
 *
 * 成交价 = 销售价格 - 商家优惠（卖家承担的折扣/券）
 * 按比例费用（以成交价为基数）：平台佣金、交易手续费、达人联盟佣金
 * 固定费用：采购成本、包装成本、净运费（运费 - 运费补贴）、单件广告分摊、其他成本
 * 单件利润 = 成交价 - 按比例费用 - 固定费用
 *
 * 注意：此为“估算”。平台实际结算可能含税费、活动费、服务费等差异，
 * 以平台结算账单为准。
 */

function calcUnitProfit(input) {
  const price = int(input.price_sen);
  const discount = int(input.seller_discount_sen);
  const net = price - discount;

  const rates = {
    commission: num(input.commission_rate),
    transaction: num(input.transaction_fee_rate),
    affiliate: num(input.affiliate_rate),
  };
  const commission = Math.round((net * rates.commission) / 100);
  const transaction = Math.round((net * rates.transaction) / 100);
  const affiliate = Math.round((net * rates.affiliate) / 100);

  const fixed = {
    purchase: int(input.purchase_cost_sen),
    packaging: int(input.packaging_cost_sen),
    shippingNet: int(input.shipping_cost_sen) - int(input.shipping_subsidy_sen),
    ads: int(input.ad_cost_per_unit_sen),
    other: int(input.other_cost_sen),
  };
  const fixedTotal = Object.values(fixed).reduce((a, b) => a + b, 0);
  const variableTotal = commission + transaction + affiliate;
  const totalCost = fixedTotal + variableTotal;
  const profit = net - totalCost;
  const rateSum = rates.commission + rates.transaction + rates.affiliate;

  // 保本售价：成交价 × (1 - 费率合计) = 固定费用 → 再加回商家优惠
  const breakEven = rateSum < 100 ? Math.ceil(fixedTotal / (1 - rateSum / 100)) + discount : null;

  return {
    netPriceSen: net,
    breakdown: {
      purchaseSen: fixed.purchase,
      packagingSen: fixed.packaging,
      commissionSen: commission,
      transactionFeeSen: transaction,
      affiliateSen: affiliate,
      shippingNetSen: fixed.shippingNet,
      adsSen: fixed.ads,
      otherSen: fixed.other,
    },
    totalCostSen: totalCost,
    profitSen: profit,
    marginPct: net > 0 ? round2((profit / net) * 100) : null,
    breakEvenPriceSen: breakEven,
    rateSumPct: round2(rateSum),
    isLoss: profit < 0,
  };
}

/** 达到目标利润率所需售价 */
function priceForTargetMargin(input, targetMarginPct) {
  const fixedTotal = int(input.purchase_cost_sen) + int(input.packaging_cost_sen)
    + int(input.shipping_cost_sen) - int(input.shipping_subsidy_sen)
    + int(input.ad_cost_per_unit_sen) + int(input.other_cost_sen);
  const rateSum = num(input.commission_rate) + num(input.transaction_fee_rate) + num(input.affiliate_rate);
  const denom = 1 - (rateSum + num(targetMarginPct)) / 100;
  if (denom <= 0) return null;
  return Math.ceil(fixedTotal / denom) + int(input.seller_discount_sen);
}

/** 计算一批数量下的利润 */
function calcForQuantity(input, qty) {
  const u = calcUnitProfit(input);
  const q = Math.max(0, Math.floor(num(qty)));
  return { quantity: q, revenueSen: u.netPriceSen * q, costSen: u.totalCostSen * q, profitSen: u.profitSen * q };
}

const int = (v) => (v == null || v === '' ? 0 : Math.round(Number(v)) || 0);
const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { calcUnitProfit, priceForTargetMargin, calcForQuantity };
