import { getOrderSignature, getVammNodeGenerator, NodeList } from './NodeList';
import {
	BN,
	calculateAskPrice,
	calculateBidPrice,
	convertToNumber,
	DLOBNode,
	DLOBNodeType,
	DriftClient,
	getLimitPrice,
	getVariant,
	isFallbackAvailableLiquiditySource,
	isOneOfVariant,
	isOrderExpired,
	isRestingLimitOrder,
	isTakingOrder,
	isTriggered,
	isVariant,
	MarketType,
	MarketTypeStr,
	mustBeTriggered,
	OraclePriceData,
	Order,
	OrderActionRecord,
	OrderRecord,
	PerpMarketAccount,
	PRICE_PRECISION,
	SlotSubscriber,
	SpotMarketAccount,
	StateAccount,
	TriggerOrderNode,
	UserMap,
} from '..';
import { PublicKey } from '@solana/web3.js';
import { ammPaused, exchangePaused, fillPaused } from '../math/exchangeStatus';
import { DLOBOrders } from './DLOBOrders';
import {
	createL2Levels,
	getL2GeneratorFromDLOBNodes,
	L2OrderBook,
	L2OrderBookGenerator,
	L3Level,
	L3OrderBook,
	mergeL2LevelGenerators,
} from './orderBookLevels';

export type MarketNodeLists = {
	restingLimit: {
		ask: NodeList<'restingLimit'>;
		bid: NodeList<'restingLimit'>;
	};
	floatingLimit: {
		ask: NodeList<'floatingLimit'>;
		bid: NodeList<'floatingLimit'>;
	};
	takingLimit: {
		ask: NodeList<'takingLimit'>;
		bid: NodeList<'takingLimit'>;
	};
	market: {
		ask: NodeList<'market'>;
		bid: NodeList<'market'>;
	};
	trigger: {
		above: NodeList<'trigger'>;
		below: NodeList<'trigger'>;
	};
};

type OrderBookCallback = () => void;

export type NodeToFill = {
	node: DLOBNode;
	makerNodes: DLOBNode[];
};

export type NodeToTrigger = {
	node: TriggerOrderNode;
};

const SUPPORTED_ORDER_TYPES = [
	'market',
	'limit',
	'triggerMarket',
	'triggerLimit',
	'oracle',
];

export class DLOB {
	openOrders = new Map<MarketTypeStr, Set<string>>();
	orderLists = new Map<MarketTypeStr, Map<number, MarketNodeLists>>();
	maxSlotForRestingLimitOrders = 0;

	initialized = false;

	public constructor() {
		this.init();
	}

	private init() {
		this.openOrders.set('perp', new Set<string>());
		this.openOrders.set('spot', new Set<string>());
		this.orderLists.set('perp', new Map<number, MarketNodeLists>());
		this.orderLists.set('spot', new Map<number, MarketNodeLists>());
	}

	public clear() {
		for (const marketType of this.openOrders.keys()) {
			this.openOrders.get(marketType).clear();
		}
		this.openOrders.clear();

		for (const marketType of this.orderLists.keys()) {
			for (const marketIndex of this.orderLists.get(marketType).keys()) {
				const marketNodeLists = this.orderLists
					.get(marketType)
					.get(marketIndex);
				for (const side of Object.keys(marketNodeLists)) {
					for (const orderType of Object.keys(marketNodeLists[side])) {
						marketNodeLists[side][orderType].clear();
					}
				}
			}
		}
		this.orderLists.clear();

		this.maxSlotForRestingLimitOrders = 0;

		this.init();
	}

	/**
	 * initializes a new DLOB instance
	 *
	 * @returns a promise that resolves when the DLOB is initialized
	 */
	public async initFromUserMap(
		userMap: UserMap,
		slot: number
	): Promise<boolean> {
		if (this.initialized) {
			return false;
		}

		// initialize the dlob with the user map
		for (const user of userMap.values()) {
			const userAccount = user.getUserAccount();
			const userAccountPubkey = user.getUserAccountPublicKey();

			for (const order of userAccount.orders) {
				this.insertOrder(order, userAccountPubkey, slot);
			}
		}

		this.initialized = true;
		return true;
	}

	public initFromOrders(dlobOrders: DLOBOrders, slot: number): boolean {
		if (this.initialized) {
			return false;
		}

		for (const { user, order } of dlobOrders) {
			this.insertOrder(order, user, slot);
		}

		this.initialized = true;
		return true;
	}

	public handleOrderRecord(record: OrderRecord, slot: number): void {
		this.insertOrder(record.order, record.user, slot);
	}

	public handleOrderActionRecord(
		record: OrderActionRecord,
		slot: number
	): void {
		if (isOneOfVariant(record.action, ['place', 'expire'])) {
			return;
		}

		if (isVariant(record.action, 'trigger')) {
			if (record.taker !== null) {
				const takerOrder = this.getOrder(record.takerOrderId, record.taker);
				if (takerOrder) {
					this.trigger(takerOrder, record.taker, slot);
				}
			}

			if (record.maker !== null) {
				const makerOrder = this.getOrder(record.makerOrderId, record.maker);
				if (makerOrder) {
					this.trigger(makerOrder, record.maker, slot);
				}
			}
		} else if (isVariant(record.action, 'fill')) {
			if (record.taker !== null) {
				const takerOrder = this.getOrder(record.takerOrderId, record.taker);
				if (takerOrder) {
					this.updateOrder(
						takerOrder,
						record.taker,
						slot,
						record.takerOrderCumulativeBaseAssetAmountFilled
					);
				}
			}

			if (record.maker !== null) {
				const makerOrder = this.getOrder(record.makerOrderId, record.maker);
				if (makerOrder) {
					this.updateOrder(
						makerOrder,
						record.maker,
						slot,
						record.makerOrderCumulativeBaseAssetAmountFilled
					);
				}
			}
		} else if (isVariant(record.action, 'cancel')) {
			if (record.taker !== null) {
				const takerOrder = this.getOrder(record.takerOrderId, record.taker);
				if (takerOrder) {
					this.delete(takerOrder, record.taker, slot);
				}
			}

			if (record.maker !== null) {
				const makerOrder = this.getOrder(record.makerOrderId, record.maker);
				if (makerOrder) {
					this.delete(makerOrder, record.maker, slot);
				}
			}
		}
	}

	public insertOrder(
		order: Order,
		userAccount: PublicKey,
		slot: number,
		onInsert?: OrderBookCallback
	): void {
		if (isVariant(order.status, 'init')) {
			return;
		}

		if (!isOneOfVariant(order.orderType, SUPPORTED_ORDER_TYPES)) {
			return;
		}

		const marketType = getVariant(order.marketType) as MarketTypeStr;

		if (!this.orderLists.get(marketType).has(order.marketIndex)) {
			this.addOrderList(marketType, order.marketIndex);
		}

		if (isVariant(order.status, 'open')) {
			this.openOrders
				.get(marketType)
				.add(getOrderSignature(order.orderId, userAccount));
		}
		this.getListForOrder(order, slot)?.insert(order, marketType, userAccount);

		if (onInsert) {
			onInsert();
		}
	}

	addOrderList(marketType: MarketTypeStr, marketIndex: number): void {
		this.orderLists.get(marketType).set(marketIndex, {
			restingLimit: {
				ask: new NodeList('restingLimit', 'asc'),
				bid: new NodeList('restingLimit', 'desc'),
			},
			floatingLimit: {
				ask: new NodeList('floatingLimit', 'asc'),
				bid: new NodeList('floatingLimit', 'desc'),
			},
			takingLimit: {
				ask: new NodeList('takingLimit', 'asc'),
				bid: new NodeList('takingLimit', 'asc'), // always sort ascending for market orders
			},
			market: {
				ask: new NodeList('market', 'asc'),
				bid: new NodeList('market', 'asc'), // always sort ascending for market orders
			},
			trigger: {
				above: new NodeList('trigger', 'asc'),
				below: new NodeList('trigger', 'desc'),
			},
		});
	}

	public updateOrder(
		order: Order,
		userAccount: PublicKey,
		slot: number,
		cumulativeBaseAssetAmountFilled: BN,
		onUpdate?: OrderBookCallback
	): void {
		this.updateRestingLimitOrders(slot);

		if (order.baseAssetAmount.eq(cumulativeBaseAssetAmountFilled)) {
			this.delete(order, userAccount, slot);
			return;
		}

		if (order.baseAssetAmountFilled.eq(cumulativeBaseAssetAmountFilled)) {
			return;
		}

		const newOrder = {
			...order,
		};
		newOrder.baseAssetAmountFilled = cumulativeBaseAssetAmountFilled;

		this.getListForOrder(order, slot)?.update(newOrder, userAccount);

		if (onUpdate) {
			onUpdate();
		}
	}

	public trigger(
		order: Order,
		userAccount: PublicKey,
		slot: number,
		onTrigger?: OrderBookCallback
	): void {
		if (isVariant(order.status, 'init')) {
			return;
		}

		this.updateRestingLimitOrders(slot);

		if (isTriggered(order)) {
			return;
		}

		const marketType = getVariant(order.marketType) as MarketTypeStr;

		const triggerList = this.orderLists.get(marketType).get(order.marketIndex)
			.trigger[isVariant(order.triggerCondition, 'above') ? 'above' : 'below'];
		triggerList.remove(order, userAccount);

		this.getListForOrder(order, slot)?.insert(order, marketType, userAccount);
		if (onTrigger) {
			onTrigger();
		}
	}

	public delete(
		order: Order,
		userAccount: PublicKey,
		slot: number,
		onDelete?: OrderBookCallback
	): void {
		if (isVariant(order.status, 'init')) {
			return;
		}

		this.updateRestingLimitOrders(slot);

		this.getListForOrder(order, slot)?.remove(order, userAccount);
		if (onDelete) {
			onDelete();
		}
	}

	public getListForOrder(
		order: Order,
		slot: number
	): NodeList<any> | undefined {
		const isInactiveTriggerOrder =
			mustBeTriggered(order) && !isTriggered(order);

		let type: DLOBNodeType;
		if (isInactiveTriggerOrder) {
			type = 'trigger';
		} else if (
			isOneOfVariant(order.orderType, ['market', 'triggerMarket', 'oracle'])
		) {
			type = 'market';
		} else if (order.oraclePriceOffset !== 0) {
			type = 'floatingLimit';
		} else {
			const isResting = isRestingLimitOrder(order, slot);
			type = isResting ? 'restingLimit' : 'takingLimit';
		}

		let subType: string;
		if (isInactiveTriggerOrder) {
			subType = isVariant(order.triggerCondition, 'above') ? 'above' : 'below';
		} else {
			subType = isVariant(order.direction, 'long') ? 'bid' : 'ask';
		}

		const marketType = getVariant(order.marketType) as MarketTypeStr;

		if (!this.orderLists.has(marketType)) {
			return undefined;
		}

		return this.orderLists.get(marketType).get(order.marketIndex)[type][
			subType
		];
	}

	public updateRestingLimitOrders(slot: number): void {
		if (slot <= this.maxSlotForRestingLimitOrders) {
			return;
		}

		this.maxSlotForRestingLimitOrders = slot;

		this.updateRestingLimitOrdersForMarketType(slot, 'perp');

		this.updateRestingLimitOrdersForMarketType(slot, 'spot');
	}

	updateRestingLimitOrdersForMarketType(
		slot: number,
		marketTypeStr: MarketTypeStr
	): void {
		for (const [_, nodeLists] of this.orderLists.get(marketTypeStr)) {
			const nodesToUpdate = [];
			for (const node of nodeLists.takingLimit.ask.getGenerator()) {
				if (!isRestingLimitOrder(node.order, slot)) {
					continue;
				}

				nodesToUpdate.push({
					side: 'ask',
					node,
				});
			}

			for (const node of nodeLists.takingLimit.bid.getGenerator()) {
				if (!isRestingLimitOrder(node.order, slot)) {
					continue;
				}

				nodesToUpdate.push({
					side: 'bid',
					node,
				});
			}

			for (const nodeToUpdate of nodesToUpdate) {
				const { side, node } = nodeToUpdate;
				nodeLists.takingLimit[side].remove(node.order, node.userAccount);
				nodeLists.restingLimit[side].insert(
					node.order,
					marketTypeStr,
					node.userAccount
				);
			}
		}
	}

	public getOrder(orderId: number, userAccount: PublicKey): Order | undefined {
		const orderSignature = getOrderSignature(orderId, userAccount);
		for (const nodeList of this.getNodeLists()) {
			const node = nodeList.get(orderSignature);
			if (node) {
				return node.order;
			}
		}

		return undefined;
	}

	public findNodesToFill(
		marketIndex: number,
		fallbackBid: BN | undefined,
		fallbackAsk: BN | undefined,
		slot: number,
		ts: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		stateAccount: StateAccount,
		marketAccount: PerpMarketAccount | SpotMarketAccount
	): NodeToFill[] {
		if (fillPaused(stateAccount, marketAccount)) {
			return [];
		}

		const isAmmPaused = ammPaused(stateAccount, marketAccount);

		const minAuctionDuration = isVariant(marketType, 'perp')
			? stateAccount.minPerpAuctionDuration
			: 0;

		const restingLimitOrderNodesToFill: Array<NodeToFill> =
			this.findRestingLimitOrderNodesToFill(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				isAmmPaused,
				minAuctionDuration,
				fallbackAsk,
				fallbackBid
			);

		const takingOrderNodesToFill: Array<NodeToFill> =
			this.findTakingNodesToFill(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				isAmmPaused,
				minAuctionDuration,
				fallbackAsk,
				fallbackBid
			);

		// get expired market nodes
		const expiredNodesToFill = this.findExpiredNodesToFill(
			marketIndex,
			ts,
			marketType
		);

		// for spot, multiple makers isn't supported, so don't merge
		if (isVariant(marketType, 'spot')) {
			return restingLimitOrderNodesToFill.concat(
				takingOrderNodesToFill,
				expiredNodesToFill
			);
		}

		return this.mergeNodesToFill(
			restingLimitOrderNodesToFill,
			takingOrderNodesToFill
		).concat(expiredNodesToFill);
	}

	mergeNodesToFill(
		restingLimitOrderNodesToFill: NodeToFill[],
		takingOrderNodesToFill: NodeToFill[]
	): NodeToFill[] {
		const mergedNodesToFill = new Map<string, NodeToFill>();

		const mergeNodesToFillHelper = (nodesToFillArray: NodeToFill[]) => {
			nodesToFillArray.forEach((nodeToFill) => {
				const nodeSignature = getOrderSignature(
					nodeToFill.node.order.orderId,
					nodeToFill.node.userAccount
				);

				if (!mergedNodesToFill.has(nodeSignature)) {
					mergedNodesToFill.set(nodeSignature, {
						node: nodeToFill.node,
						makerNodes: [],
					});
				}

				if (nodeToFill.makerNodes) {
					mergedNodesToFill
						.get(nodeSignature)
						.makerNodes.push(...nodeToFill.makerNodes);
				}
			});
		};

		mergeNodesToFillHelper(restingLimitOrderNodesToFill);
		mergeNodesToFillHelper(takingOrderNodesToFill);

		return Array.from(mergedNodesToFill.values());
	}

	public findRestingLimitOrderNodesToFill(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		isAmmPaused: boolean,
		minAuctionDuration: number,
		fallbackAsk: BN | undefined,
		fallbackBid: BN | undefined
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		const crossingNodes = this.findCrossingRestingLimitOrders(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		);

		for (const crossingNode of crossingNodes) {
			nodesToFill.push(crossingNode);
		}

		if (fallbackBid && !isAmmPaused) {
			const askGenerator = this.getRestingLimitAsks(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);
			const asksCrossingFallback = this.findNodesCrossingFallbackLiquidity(
				marketType,
				slot,
				oraclePriceData,
				askGenerator,
				fallbackBid,
				(askPrice, fallbackPrice) => {
					return askPrice.lte(fallbackPrice);
				},
				minAuctionDuration
			);

			for (const askCrossingFallback of asksCrossingFallback) {
				nodesToFill.push(askCrossingFallback);
			}
		}

		if (fallbackAsk && !isAmmPaused) {
			const bidGenerator = this.getRestingLimitBids(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);
			const bidsCrossingFallback = this.findNodesCrossingFallbackLiquidity(
				marketType,
				slot,
				oraclePriceData,
				bidGenerator,
				fallbackAsk,
				(bidPrice, fallbackPrice) => {
					return bidPrice.gte(fallbackPrice);
				},
				minAuctionDuration
			);

			for (const bidCrossingFallback of bidsCrossingFallback) {
				nodesToFill.push(bidCrossingFallback);
			}
		}

		return nodesToFill;
	}

	public findTakingNodesToFill(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		isAmmPaused: boolean,
		minAuctionDuration: number,
		fallbackAsk: BN | undefined,
		fallbackBid?: BN | undefined
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		let takingOrderGenerator = this.getTakingAsks(
			marketIndex,
			marketType,
			slot,
			oraclePriceData
		);

		const takingAsksCrossingBids = this.findTakingNodesCrossingMakerNodes(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			takingOrderGenerator,
			this.getMakerLimitBids.bind(this),
			(takerPrice, makerPrice) => {
				if (isVariant(marketType, 'spot')) {
					if (takerPrice === undefined) {
						return false;
					}

					if (fallbackBid && makerPrice.lt(fallbackBid)) {
						return false;
					}
				}
				return takerPrice === undefined || takerPrice.lte(makerPrice);
			},
			fallbackAsk
		);
		for (const takingAskCrossingBid of takingAsksCrossingBids) {
			nodesToFill.push(takingAskCrossingBid);
		}

		if (fallbackBid && !isAmmPaused) {
			takingOrderGenerator = this.getTakingAsks(
				marketIndex,
				marketType,
				slot,
				oraclePriceData
			);
			const takingAsksCrossingFallback =
				this.findNodesCrossingFallbackLiquidity(
					marketType,
					slot,
					oraclePriceData,
					takingOrderGenerator,
					fallbackBid,
					(takerPrice, fallbackPrice) => {
						return takerPrice === undefined || takerPrice.lte(fallbackPrice);
					},
					minAuctionDuration
				);

			for (const takingAskCrossingFallback of takingAsksCrossingFallback) {
				nodesToFill.push(takingAskCrossingFallback);
			}
		}

		takingOrderGenerator = this.getTakingBids(
			marketIndex,
			marketType,
			slot,
			oraclePriceData
		);

		const takingBidsToFill = this.findTakingNodesCrossingMakerNodes(
			marketIndex,
			slot,
			marketType,
			oraclePriceData,
			takingOrderGenerator,
			this.getMakerLimitAsks.bind(this),
			(takerPrice, makerPrice) => {
				if (isVariant(marketType, 'spot')) {
					if (takerPrice === undefined) {
						return false;
					}

					if (fallbackAsk && makerPrice.gt(fallbackAsk)) {
						return false;
					}
				}

				return takerPrice === undefined || takerPrice.gte(makerPrice);
			},
			fallbackBid
		);

		for (const takingBidToFill of takingBidsToFill) {
			nodesToFill.push(takingBidToFill);
		}

		if (fallbackAsk && !isAmmPaused) {
			takingOrderGenerator = this.getTakingBids(
				marketIndex,
				marketType,
				slot,
				oraclePriceData
			);
			const takingBidsCrossingFallback =
				this.findNodesCrossingFallbackLiquidity(
					marketType,
					slot,
					oraclePriceData,
					takingOrderGenerator,
					fallbackAsk,
					(takerPrice, fallbackPrice) => {
						return takerPrice === undefined || takerPrice.gte(fallbackPrice);
					},
					minAuctionDuration
				);
			for (const marketBidCrossingFallback of takingBidsCrossingFallback) {
				nodesToFill.push(marketBidCrossingFallback);
			}
		}

		return nodesToFill;
	}

	public findTakingNodesCrossingMakerNodes(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		takerNodeGenerator: Generator<DLOBNode>,
		makerNodeGeneratorFn: (
			marketIndex: number,
			slot: number,
			marketType: MarketType,
			oraclePriceData: OraclePriceData,
			fallbackPrice?: BN
		) => Generator<DLOBNode>,
		doesCross: (takerPrice: BN | undefined, makerPrice: BN) => boolean,
		fallbackPrice?: BN
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		for (const takerNode of takerNodeGenerator) {
			const makerNodeGenerator = makerNodeGeneratorFn(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				fallbackPrice
			);

			for (const makerNode of makerNodeGenerator) {
				// Can't match orders from the same user
				const sameUser = takerNode.userAccount.equals(makerNode.userAccount);
				if (sameUser) {
					continue;
				}

				const makerPrice = makerNode.getPrice(oraclePriceData, slot);
				const takerPrice = takerNode.getPrice(oraclePriceData, slot);

				const ordersCross = doesCross(takerPrice, makerPrice);
				if (!ordersCross) {
					// market orders aren't sorted by price, they are sorted by time, so we need to traverse
					// through all of em
					break;
				}

				nodesToFill.push({
					node: takerNode,
					makerNodes: [makerNode],
				});

				const makerOrder = makerNode.order;
				const takerOrder = takerNode.order;

				const makerBaseRemaining = makerOrder.baseAssetAmount.sub(
					makerOrder.baseAssetAmountFilled
				);
				const takerBaseRemaining = takerOrder.baseAssetAmount.sub(
					takerOrder.baseAssetAmountFilled
				);

				const baseFilled = BN.min(makerBaseRemaining, takerBaseRemaining);

				const newMakerOrder = { ...makerOrder };
				newMakerOrder.baseAssetAmountFilled =
					makerOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOrder(newMakerOrder, slot).update(
					newMakerOrder,
					makerNode.userAccount
				);

				const newTakerOrder = { ...takerOrder };
				newTakerOrder.baseAssetAmountFilled =
					takerOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOrder(newTakerOrder, slot).update(
					newTakerOrder,
					takerNode.userAccount
				);

				if (
					newTakerOrder.baseAssetAmountFilled.eq(takerOrder.baseAssetAmount)
				) {
					break;
				}
			}
		}

		return nodesToFill;
	}

	public findNodesCrossingFallbackLiquidity(
		marketType: MarketType,
		slot: number,
		oraclePriceData: OraclePriceData,
		nodeGenerator: Generator<DLOBNode>,
		fallbackPrice: BN,
		doesCross: (nodePrice: BN | undefined, fallbackPrice: BN) => boolean,
		minAuctionDuration: number
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		let nextNode = nodeGenerator.next();
		while (!nextNode.done) {
			const node = nextNode.value;

			if (isVariant(marketType, 'spot') && node.order?.postOnly) {
				nextNode = nodeGenerator.next();
				continue;
			}

			const nodePrice = getLimitPrice(node.order, oraclePriceData, slot);

			// order crosses if there is no limit price or it crosses fallback price
			const crosses = doesCross(nodePrice, fallbackPrice);

			// fallback is available if auction is complete or it's a spot order
			const fallbackAvailable =
				isVariant(marketType, 'spot') ||
				isFallbackAvailableLiquiditySource(
					node.order,
					minAuctionDuration,
					slot
				);

			if (crosses && fallbackAvailable) {
				nodesToFill.push({
					node: node,
					makerNodes: [], // filled by fallback
				});
			}

			nextNode = nodeGenerator.next();
		}

		return nodesToFill;
	}

	public findExpiredNodesToFill(
		marketIndex: number,
		ts: number,
		marketType: MarketType
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		if (!nodeLists) {
			return nodesToFill;
		}

		// All bids/asks that can expire
		const bidGenerators = [
			nodeLists.takingLimit.bid.getGenerator(),
			nodeLists.restingLimit.bid.getGenerator(),
			nodeLists.floatingLimit.bid.getGenerator(),
			nodeLists.market.bid.getGenerator(),
		];
		const askGenerators = [
			nodeLists.takingLimit.ask.getGenerator(),
			nodeLists.restingLimit.ask.getGenerator(),
			nodeLists.floatingLimit.ask.getGenerator(),
			nodeLists.market.ask.getGenerator(),
		];

		for (const bidGenerator of bidGenerators) {
			for (const bid of bidGenerator) {
				if (isOrderExpired(bid.order, ts)) {
					nodesToFill.push({
						node: bid,
						makerNodes: [],
					});
				}
			}
		}

		for (const askGenerator of askGenerators) {
			for (const ask of askGenerator) {
				if (isOrderExpired(ask.order, ts)) {
					nodesToFill.push({
						node: ask,
						makerNodes: [],
					});
				}
			}
		}

		return nodesToFill;
	}

	public findJitAuctionNodesToFill(
		marketIndex: number,
		slot: number,
		oraclePriceData: OraclePriceData,
		marketType: MarketType
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();
		// Then see if there are orders still in JIT auction
		for (const marketBid of this.getTakingBids(
			marketIndex,
			marketType,
			slot,
			oraclePriceData
		)) {
			nodesToFill.push({
				node: marketBid,
				makerNodes: [],
			});
		}

		for (const marketAsk of this.getTakingAsks(
			marketIndex,
			marketType,
			slot,
			oraclePriceData
		)) {
			nodesToFill.push({
				node: marketAsk,
				makerNodes: [],
			});
		}
		return nodesToFill;
	}

	*getTakingBids(
		marketIndex: number,
		marketType: MarketType,
		slot: number,
		oraclePriceData: OraclePriceData
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const orderLists = this.orderLists.get(marketTypeStr).get(marketIndex);
		if (!orderLists) {
			return;
		}

		this.updateRestingLimitOrders(slot);

		const generatorList = [
			orderLists.market.bid.getGenerator(),
			orderLists.takingLimit.bid.getGenerator(),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode) => {
				return bestNode.order.slot.lt(currentNode.order.slot);
			}
		);
	}

	*getTakingAsks(
		marketIndex: number,
		marketType: MarketType,
		slot: number,
		oraclePriceData: OraclePriceData
	): Generator<DLOBNode> {
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const orderLists = this.orderLists.get(marketTypeStr).get(marketIndex);
		if (!orderLists) {
			return;
		}

		this.updateRestingLimitOrders(slot);

		const generatorList = [
			orderLists.market.ask.getGenerator(),
			orderLists.takingLimit.ask.getGenerator(),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode) => {
				return bestNode.order.slot.lt(currentNode.order.slot);
			}
		);
	}

	private *getBestNode(
		generatorList: Array<Generator<DLOBNode>>,
		oraclePriceData: OraclePriceData,
		slot: number,
		compareFcn: (
			bestDLOBNode: DLOBNode,
			currentDLOBNode: DLOBNode,
			slot: number,
			oraclePriceData: OraclePriceData
		) => boolean
	): Generator<DLOBNode> {
		const generators = generatorList.map((generator) => {
			return {
				next: generator.next(),
				generator,
			};
		});

		let sideExhausted = false;
		while (!sideExhausted) {
			const bestGenerator = generators.reduce(
				(bestGenerator, currentGenerator) => {
					if (currentGenerator.next.done) {
						return bestGenerator;
					}

					if (bestGenerator.next.done) {
						return currentGenerator;
					}

					const bestValue = bestGenerator.next.value as DLOBNode;
					const currentValue = currentGenerator.next.value as DLOBNode;

					return compareFcn(bestValue, currentValue, slot, oraclePriceData)
						? bestGenerator
						: currentGenerator;
				}
			);

			if (!bestGenerator.next.done) {
				// skip this node if it's already completely filled
				if (bestGenerator.next.value.isBaseFilled()) {
					bestGenerator.next = bestGenerator.generator.next();
					continue;
				}

				yield bestGenerator.next.value;
				bestGenerator.next = bestGenerator.generator.next();
			} else {
				sideExhausted = true;
			}
		}
	}

	*getRestingLimitAsks(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot asks');
		}

		this.updateRestingLimitOrders(slot);

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		if (!nodeLists) {
			return;
		}

		const generatorList = [
			nodeLists.restingLimit.ask.getGenerator(),
			nodeLists.floatingLimit.ask.getGenerator(),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				return bestNode
					.getPrice(oraclePriceData, slot)
					.lt(currentNode.getPrice(oraclePriceData, slot));
			}
		);
	}

	/**
	 * Filters the limit asks that are resting and do not cross fallback bid
	 * Taking orders can only fill against orders that meet this criteria
	 *
	 * @returns
	 */
	*getMakerLimitAsks(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		fallbackBid?: BN
	): Generator<DLOBNode> {
		const isPerpMarket = isVariant(marketType, 'perp');
		for (const node of this.getRestingLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		)) {
			if (
				isPerpMarket &&
				fallbackBid &&
				node.getPrice(oraclePriceData, slot).lte(fallbackBid)
			) {
				continue;
			}
			yield node;
		}
	}

	*getRestingLimitBids(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot bids');
		}

		this.updateRestingLimitOrders(slot);

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const nodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		if (!nodeLists) {
			return;
		}

		const generatorList = [
			nodeLists.restingLimit.bid.getGenerator(),
			nodeLists.floatingLimit.bid.getGenerator(),
		];

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				return bestNode
					.getPrice(oraclePriceData, slot)
					.gt(currentNode.getPrice(oraclePriceData, slot));
			}
		);
	}

	/**
	 * Filters the limit bids that are post only, have been place for sufficiently long or are below the fallback ask
	 * Market orders can only fill against orders that meet this criteria
	 *
	 * @returns
	 */
	*getMakerLimitBids(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData,
		fallbackAsk?: BN
	): Generator<DLOBNode> {
		const isPerpMarket = isVariant(marketType, 'perp');
		for (const node of this.getRestingLimitBids(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		)) {
			if (
				isPerpMarket &&
				fallbackAsk &&
				node.getPrice(oraclePriceData, slot).gte(fallbackAsk)
			) {
				continue;
			}
			yield node;
		}
	}

	*getAsks(
		marketIndex: number,
		fallbackAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot asks');
		}

		const generatorList = [
			this.getTakingAsks(marketIndex, marketType, slot, oraclePriceData),
			this.getRestingLimitAsks(marketIndex, slot, marketType, oraclePriceData),
		];

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		if (marketTypeStr === 'perp' && fallbackAsk) {
			generatorList.push(getVammNodeGenerator(fallbackAsk));
		}

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				const bestNodeTaking = bestNode.order
					? isTakingOrder(bestNode.order, slot)
					: false;
				const currentNodeTaking = currentNode.order
					? isTakingOrder(currentNode.order, slot)
					: false;

				if (bestNodeTaking && currentNodeTaking) {
					return bestNode.order.slot.lt(currentNode.order.slot);
				}

				if (bestNodeTaking) {
					return true;
				}

				if (currentNodeTaking) {
					return false;
				}

				return bestNode
					.getPrice(oraclePriceData, slot)
					.lt(currentNode.getPrice(oraclePriceData, slot));
			}
		);
	}

	*getBids(
		marketIndex: number,
		fallbackBid: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): Generator<DLOBNode> {
		if (isVariant(marketType, 'spot') && !oraclePriceData) {
			throw new Error('Must provide OraclePriceData to get spot bids');
		}

		const generatorList = [
			this.getTakingBids(marketIndex, marketType, slot, oraclePriceData),
			this.getRestingLimitBids(marketIndex, slot, marketType, oraclePriceData),
		];

		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		if (marketTypeStr === 'perp' && fallbackBid) {
			generatorList.push(getVammNodeGenerator(fallbackBid));
		}

		yield* this.getBestNode(
			generatorList,
			oraclePriceData,
			slot,
			(bestNode, currentNode, slot, oraclePriceData) => {
				const bestNodeTaking = bestNode.order
					? isTakingOrder(bestNode.order, slot)
					: false;
				const currentNodeTaking = currentNode.order
					? isTakingOrder(currentNode.order, slot)
					: false;

				if (bestNodeTaking && currentNodeTaking) {
					return bestNode.order.slot.lt(currentNode.order.slot);
				}

				if (bestNodeTaking) {
					return true;
				}

				if (currentNodeTaking) {
					return false;
				}

				return bestNode
					.getPrice(oraclePriceData, slot)
					.gt(currentNode.getPrice(oraclePriceData, slot));
			}
		);
	}

	findCrossingRestingLimitOrders(
		marketIndex: number,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();

		for (const askNode of this.getRestingLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		)) {
			const bidGenerator = this.getRestingLimitBids(
				marketIndex,
				slot,
				marketType,
				oraclePriceData
			);

			for (const bidNode of bidGenerator) {
				const bidPrice = bidNode.getPrice(oraclePriceData, slot);
				const askPrice = askNode.getPrice(oraclePriceData, slot);

				// orders don't cross
				if (bidPrice.lt(askPrice)) {
					break;
				}

				const bidOrder = bidNode.order;
				const askOrder = askNode.order;

				// Can't match orders from the same user
				const sameUser = bidNode.userAccount.equals(askNode.userAccount);
				if (sameUser) {
					continue;
				}

				const makerAndTaker = this.determineMakerAndTaker(askNode, bidNode);

				// unable to match maker and taker due to post only or slot
				if (!makerAndTaker) {
					continue;
				}

				const { takerNode, makerNode } = makerAndTaker;

				const bidBaseRemaining = bidOrder.baseAssetAmount.sub(
					bidOrder.baseAssetAmountFilled
				);
				const askBaseRemaining = askOrder.baseAssetAmount.sub(
					askOrder.baseAssetAmountFilled
				);

				const baseFilled = BN.min(bidBaseRemaining, askBaseRemaining);

				const newBidOrder = { ...bidOrder };
				newBidOrder.baseAssetAmountFilled =
					bidOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOrder(newBidOrder, slot).update(
					newBidOrder,
					bidNode.userAccount
				);

				// ask completely filled
				const newAskOrder = { ...askOrder };
				newAskOrder.baseAssetAmountFilled =
					askOrder.baseAssetAmountFilled.add(baseFilled);
				this.getListForOrder(newAskOrder, slot).update(
					newAskOrder,
					askNode.userAccount
				);

				nodesToFill.push({
					node: takerNode,
					makerNodes: [makerNode],
				});

				if (newAskOrder.baseAssetAmount.eq(newAskOrder.baseAssetAmountFilled)) {
					break;
				}
			}
		}

		return nodesToFill;
	}

	determineMakerAndTaker(
		askNode: DLOBNode,
		bidNode: DLOBNode
	): { takerNode: DLOBNode; makerNode: DLOBNode } | undefined {
		const askSlot = askNode.order.slot.add(
			new BN(askNode.order.auctionDuration)
		);
		const bidSlot = bidNode.order.slot.add(
			new BN(bidNode.order.auctionDuration)
		);

		if (bidNode.order.postOnly && askNode.order.postOnly) {
			return undefined;
		} else if (bidNode.order.postOnly) {
			return {
				takerNode: askNode,
				makerNode: bidNode,
			};
		} else if (askNode.order.postOnly) {
			return {
				takerNode: bidNode,
				makerNode: askNode,
			};
		} else if (askSlot.lte(bidSlot)) {
			return {
				takerNode: bidNode,
				makerNode: askNode,
			};
		} else {
			return {
				takerNode: askNode,
				makerNode: bidNode,
			};
		}
	}

	public getBestAsk(
		marketIndex: number,
		fallbackAsk: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): BN {
		return this.getAsks(
			marketIndex,
			fallbackAsk,
			slot,
			marketType,
			oraclePriceData
		)
			.next()
			.value.getPrice(oraclePriceData, slot);
	}

	public getBestBid(
		marketIndex: number,
		fallbackBid: BN | undefined,
		slot: number,
		marketType: MarketType,
		oraclePriceData: OraclePriceData
	): BN {
		return this.getBids(
			marketIndex,
			fallbackBid,
			slot,
			marketType,
			oraclePriceData
		)
			.next()
			.value.getPrice(oraclePriceData, slot);
	}

	public findNodesToTrigger(
		marketIndex: number,
		slot: number,
		oraclePrice: BN,
		marketType: MarketType,
		stateAccount: StateAccount
	): NodeToTrigger[] {
		if (exchangePaused(stateAccount)) {
			return [];
		}

		const nodesToTrigger = [];
		const marketTypeStr = getVariant(marketType) as MarketTypeStr;
		const marketNodeLists = this.orderLists.get(marketTypeStr).get(marketIndex);

		const triggerAboveList = marketNodeLists
			? marketNodeLists.trigger.above
			: undefined;
		if (triggerAboveList) {
			for (const node of triggerAboveList.getGenerator()) {
				if (oraclePrice.gt(node.order.triggerPrice)) {
					nodesToTrigger.push({
						node: node,
					});
				} else {
					break;
				}
			}
		}

		const triggerBelowList = marketNodeLists
			? marketNodeLists.trigger.below
			: undefined;
		if (triggerBelowList) {
			for (const node of triggerBelowList.getGenerator()) {
				if (oraclePrice.lt(node.order.triggerPrice)) {
					nodesToTrigger.push({
						node: node,
					});
				} else {
					break;
				}
			}
		}

		return nodesToTrigger;
	}

	public printTopOfOrderLists(
		sdkConfig: any,
		driftClient: DriftClient,
		slotSubscriber: SlotSubscriber,
		marketIndex: number,
		marketType: MarketType
	) {
		if (isVariant(marketType, 'perp')) {
			const market = driftClient.getPerpMarketAccount(marketIndex);

			const slot = slotSubscriber.getSlot();
			const oraclePriceData =
				driftClient.getOracleDataForPerpMarket(marketIndex);
			const fallbackAsk = calculateAskPrice(market, oraclePriceData);
			const fallbackBid = calculateBidPrice(market, oraclePriceData);

			const bestAsk = this.getBestAsk(
				marketIndex,
				fallbackAsk,
				slot,
				marketType,
				oraclePriceData
			);
			const bestBid = this.getBestBid(
				marketIndex,
				fallbackBid,
				slot,
				marketType,
				oraclePriceData
			);
			const mid = bestAsk.add(bestBid).div(new BN(2));

			const bidSpread =
				(convertToNumber(bestBid, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;
			const askSpread =
				(convertToNumber(bestAsk, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;

			console.log(`Market ${sdkConfig.MARKETS[marketIndex].symbol} Orders`);
			console.log(
				`  Ask`,
				convertToNumber(bestAsk, PRICE_PRECISION).toFixed(3),
				`(${askSpread.toFixed(4)}%)`
			);
			console.log(`  Mid`, convertToNumber(mid, PRICE_PRECISION).toFixed(3));
			console.log(
				`  Bid`,
				convertToNumber(bestBid, PRICE_PRECISION).toFixed(3),
				`(${bidSpread.toFixed(4)}%)`
			);
		} else if (isVariant(marketType, 'spot')) {
			const slot = slotSubscriber.getSlot();
			const oraclePriceData =
				driftClient.getOracleDataForPerpMarket(marketIndex);

			const bestAsk = this.getBestAsk(
				marketIndex,
				undefined,
				slot,
				marketType,
				oraclePriceData
			);
			const bestBid = this.getBestBid(
				marketIndex,
				undefined,
				slot,
				marketType,
				oraclePriceData
			);
			const mid = bestAsk.add(bestBid).div(new BN(2));

			const bidSpread =
				(convertToNumber(bestBid, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;
			const askSpread =
				(convertToNumber(bestAsk, PRICE_PRECISION) /
					convertToNumber(oraclePriceData.price, PRICE_PRECISION) -
					1) *
				100.0;

			console.log(`Market ${sdkConfig.MARKETS[marketIndex].symbol} Orders`);
			console.log(
				`  Ask`,
				convertToNumber(bestAsk, PRICE_PRECISION).toFixed(3),
				`(${askSpread.toFixed(4)}%)`
			);
			console.log(`  Mid`, convertToNumber(mid, PRICE_PRECISION).toFixed(3));
			console.log(
				`  Bid`,
				convertToNumber(bestBid, PRICE_PRECISION).toFixed(3),
				`(${bidSpread.toFixed(4)}%)`
			);
		}
	}

	public getDLOBOrders(): DLOBOrders {
		const dlobOrders: DLOBOrders = [];

		for (const nodeList of this.getNodeLists()) {
			for (const node of nodeList.getGenerator()) {
				dlobOrders.push({
					user: node.userAccount,
					order: node.order,
				});
			}
		}

		return dlobOrders;
	}

	*getNodeLists(): Generator<NodeList<DLOBNodeType>> {
		for (const [_, nodeLists] of this.orderLists.get('perp')) {
			yield nodeLists.restingLimit.bid;
			yield nodeLists.restingLimit.ask;
			yield nodeLists.takingLimit.bid;
			yield nodeLists.takingLimit.ask;
			yield nodeLists.market.bid;
			yield nodeLists.market.ask;
			yield nodeLists.floatingLimit.bid;
			yield nodeLists.floatingLimit.ask;
			yield nodeLists.trigger.above;
			yield nodeLists.trigger.below;
		}

		for (const [_, nodeLists] of this.orderLists.get('spot')) {
			yield nodeLists.restingLimit.bid;
			yield nodeLists.restingLimit.ask;
			yield nodeLists.takingLimit.bid;
			yield nodeLists.takingLimit.ask;
			yield nodeLists.market.bid;
			yield nodeLists.market.ask;
			yield nodeLists.floatingLimit.bid;
			yield nodeLists.floatingLimit.ask;
			yield nodeLists.trigger.above;
			yield nodeLists.trigger.below;
		}
	}

	/**
	 * Get an L2 view of the order book for a given market.
	 *
	 * @param marketIndex
	 * @param marketType
	 * @param slot
	 * @param oraclePriceData
	 * @param depth how many levels of the order book to return
	 * @param fallbackAsk best ask for fallback liquidity, only relevant for perps
	 * @param fallbackBid best bid for fallback liquidity, only relevant for perps
	 * @param fallbackL2Generators L2 generators for fallback liquidity e.g. vAMM {@link getVammL2Generator}, openbook {@link SerumSubscriber}
	 */
	public getL2({
		marketIndex,
		marketType,
		slot,
		oraclePriceData,
		depth,
		fallbackAsk,
		fallbackBid,
		fallbackL2Generators = [],
	}: {
		marketIndex: number;
		marketType: MarketType;
		slot: number;
		oraclePriceData: OraclePriceData;
		depth: number;
		fallbackAsk?: BN;
		fallbackBid?: BN;
		fallbackL2Generators?: L2OrderBookGenerator[];
	}): L2OrderBook {
		const makerAskL2LevelGenerator = getL2GeneratorFromDLOBNodes(
			this.getMakerLimitAsks(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				fallbackBid
			),
			oraclePriceData,
			slot
		);

		const fallbackAskGenerators = fallbackL2Generators.map(
			(fallbackL2Generator) => {
				return fallbackL2Generator.getL2Asks();
			}
		);

		const askL2LevelGenerator = mergeL2LevelGenerators(
			[makerAskL2LevelGenerator, ...fallbackAskGenerators],
			(a, b) => {
				return a.price.lt(b.price);
			}
		);

		const asks = createL2Levels(askL2LevelGenerator, depth);

		const makerBidGenerator = getL2GeneratorFromDLOBNodes(
			this.getMakerLimitBids(
				marketIndex,
				slot,
				marketType,
				oraclePriceData,
				fallbackAsk
			),
			oraclePriceData,
			slot
		);

		const fallbackBidGenerators = fallbackL2Generators.map((fallbackOrders) => {
			return fallbackOrders.getL2Bids();
		});

		const bidL2LevelGenerator = mergeL2LevelGenerators(
			[makerBidGenerator, ...fallbackBidGenerators],
			(a, b) => {
				return a.price.gt(b.price);
			}
		);

		const bids = createL2Levels(bidL2LevelGenerator, depth);

		return {
			bids,
			asks,
		};
	}

	/**
	 * Get an L3 view of the order book for a given market. Does not include fallback liquidity sources
	 *
	 * @param marketIndex
	 * @param marketType
	 * @param slot
	 * @param oraclePriceData
	 */
	public getL3({
		marketIndex,
		marketType,
		slot,
		oraclePriceData,
	}: {
		marketIndex: number;
		marketType: MarketType;
		slot: number;
		oraclePriceData: OraclePriceData;
	}): L3OrderBook {
		const bids: L3Level[] = [];
		const asks: L3Level[] = [];

		const restingAsks = this.getRestingLimitAsks(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		);

		for (const ask of restingAsks) {
			asks.push({
				price: ask.getPrice(oraclePriceData, slot),
				size: ask.order.baseAssetAmount.sub(ask.order.baseAssetAmountFilled),
				maker: ask.userAccount,
				orderId: ask.order.orderId,
			});
		}

		const restingBids = this.getRestingLimitBids(
			marketIndex,
			slot,
			marketType,
			oraclePriceData
		);

		for (const bid of restingBids) {
			bids.push({
				price: bid.getPrice(oraclePriceData, slot),
				size: bid.order.baseAssetAmount.sub(bid.order.baseAssetAmountFilled),
				maker: bid.userAccount,
				orderId: bid.order.orderId,
			});
		}

		return {
			bids,
			asks,
		};
	}
}
