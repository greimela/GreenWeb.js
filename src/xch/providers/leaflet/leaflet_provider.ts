import { Provider, getBalanceArgs, subscribeToPuzzleHashUpdatesArgs, subscribeToCoinUpdatesArgs, getPuzzleSolutionArgs, getCoinChildrenArgs, getBlockHeaderArgs, getBlocksHeadersArgs, getCoinRemovalsArgs, getCoinAdditionsArgs } from "../provider";
import * as providerTypes from "../provider_types";
import { makeMsg, Message } from "../../../util/serializer/types/outbound_message";
import { Serializer } from "../../../util/serializer/serializer";
import { ProtocolMessageTypes } from "../../../util/serializer/types/protocol_message_types";
import { CoinState, NewPeakWallet, PuzzleSolutionResponse, RegisterForCoinUpdates, RegisterForPhUpdates, RejectAdditionsRequest, RejectHeaderBlocks, RejectHeaderRequest, RejectPuzzleSolution, RejectRemovalsRequest, RequestAdditions, RequestBlockHeader, RequestChildren, RequestHeaderBlocks, RequestPuzzleSolution, RequestRemovals, RespondAdditions, RespondBlockHeader, RespondChildren, RespondHeaderBlocks, RespondPuzzleSolution, RespondRemovals, RespondToCoinUpdates, RespondToPhUpdates } from "../../../util/serializer/types/wallet_protocol";
import { HeaderBlock } from "../../../util/serializer/types/header_block";
import { Coin } from "../../../util/serializer/types/coin";
import { ProviderUtil } from "./provider_util";
import { AddressUtil } from "../../../util/address";
import { transferArgs, transferCATArgs, acceptOfferArgs, subscribeToAddressChangesArgs } from "../provider_args";
import { BigNumber } from "@ethersproject/bignumber";
import { MessageManager } from "./message_manager";
import { ChiaMessageChannel } from "./chia_message_channel";
import { Util } from "../../../util";

const ADDRESS_PREFIX = "xch";

const addressUtil = new AddressUtil();

export class LeafletProvider implements Provider {
    public messageManager: MessageManager;

    private blockNumber: providerTypes.Optional<number> = null;
    private networkId;

    constructor(host: string, apiKey: string, port = 18444, networkId = "mainnet") {
        this.messageManager = new MessageManager(
            async (onMessage) => new ChiaMessageChannel({
                host, port, apiKey, onMessage, networkId
            })
        );

        this.networkId = networkId;
    }

    public async connect() {
        await this.messageManager.initialize();
        this.messageManager.registerFilter({
            messageToSend: null,
            consumeMessage: (msg: Message) => {
                if(msg.type !== ProtocolMessageTypes.new_peak_wallet) {
                    return false;
                }

                const pckt: NewPeakWallet = Serializer.deserialize(
                    NewPeakWallet,
                    Buffer.from(msg.data, "hex")
                );
                this.blockNumber = BigNumber.from(pckt.height).toNumber();
                return true;
            },
            deleteAfterFirstMessageConsumed: false,
            expectedMaxRensponseWait: 120 * 1000
        });
    }

    public async close(): Promise<void> {
        await this.messageManager.close();
    }

    public getNetworkId(): string {
        return this.networkId;
    }

    public isConnected(): boolean {
        return this.messageManager.open;
    }

    public async getBlockNumber(): Promise<providerTypes.Optional<number>> {
        return this.blockNumber;
    }

    public async getBalance({
        address,
        puzzleHash,
        minHeight = 0
    }: getBalanceArgs): Promise<providerTypes.Optional<BigNumber>> {
        let puzHash: string;

        // get puzHash: Buffer from address / puzzle hash
        if(address !== undefined && address.startsWith(ADDRESS_PREFIX)) {
            puzHash = addressUtil.addressToPuzzleHash(address);
            if(puzHash.length === 0) {
                return null;
            }
        }
        else if(puzzleHash !== undefined) {
            puzHash = addressUtil.validateHashString(puzzleHash);
        }
        else return null;

        // Register for updates
        const pckt: RegisterForPhUpdates = new RegisterForPhUpdates();
        pckt.minHeight = minHeight;
        pckt.puzzleHashes = [puzHash];

        let coinStates: CoinState[] = [];
        const msgToSend: Buffer = makeMsg(
            ProtocolMessageTypes.register_interest_in_puzzle_hash,
            pckt,
        );
        await this.messageManager.registerFilter({
            messageToSend: msgToSend,
            consumeMessage: (msg: Message) => {
                if(msg.type !== ProtocolMessageTypes.respond_to_ph_update) {
                    return false;
                }
                const rPckt: RespondToPhUpdates = Serializer.deserialize(RespondToPhUpdates, msg.data);
                if(!rPckt.puzzleHashes.includes(puzHash)) {
                    return false;
                }

                coinStates = rPckt.coinStates.filter((cs) => cs.coin.puzzleHash === puzHash);
                return true;
            },
        });

        // filter received list of puzzle hashes and compute balance
        const unspentCoins: CoinState[] = coinStates.filter(
            (coinState) => coinState.spentHeight == null
        );

        let balance = BigNumber.from(0);
        for(let i = 0; i < unspentCoins.length; ++i) {
            balance = balance.add(unspentCoins[i].coin.amount);
        }

        return balance;
    }

    public subscribeToPuzzleHashUpdates({ puzzleHash, callback, minHeight = 0 }: subscribeToPuzzleHashUpdatesArgs): void {
        puzzleHash = addressUtil.validateHashString(puzzleHash);
        if(puzzleHash.length === 0) return;

        // Register for updates
        const pckt: RegisterForPhUpdates = new RegisterForPhUpdates();
        pckt.minHeight = minHeight;
        pckt.puzzleHashes = [
            puzzleHash,
        ];

        const msgToSend: Buffer = makeMsg(
            ProtocolMessageTypes.register_interest_in_puzzle_hash,
            pckt,
        );
        this.messageManager.registerFilter({
            messageToSend: msgToSend,
            consumeMessage: (msg: Message) => {
                if(msg.type !== ProtocolMessageTypes.respond_to_ph_update) {
                    return false;
                }
                const rPckt: RespondToPhUpdates = Serializer.deserialize(RespondToPhUpdates, msg.data);
                if(!rPckt.puzzleHashes.includes(puzzleHash)) {
                    return false;
                }

                const coins: providerTypes.CoinState[] = rPckt.coinStates.filter((cs) => cs.coin.puzzleHash === puzzleHash);
                callback(coins);

                return true;
            },
            deleteAfterFirstMessageConsumed: false,
            expectedMaxRensponseWait: 0
        });
    }

    public subscribeToCoinUpdates({ coinId, callback, minHeight = 0 }: subscribeToCoinUpdatesArgs): void {
        coinId = addressUtil.validateHashString(coinId);
        if(coinId.length === 0) return;

        // Register for updates
        const pckt: RegisterForCoinUpdates = new RegisterForCoinUpdates();
        pckt.minHeight = minHeight;
        pckt.coinIds = [
            coinId,
        ];

        const msgToSend: Buffer = makeMsg(
            ProtocolMessageTypes.register_interest_in_coin,
            pckt,
        );
        this.messageManager.registerFilter({
            messageToSend: msgToSend,
            consumeMessage: (msg: Message) => {
                if(msg.type !== ProtocolMessageTypes.respond_to_coin_update) {
                    return false;
                }
                const rPckt: RespondToCoinUpdates = Serializer.deserialize(RespondToCoinUpdates, msg.data);
                if(!rPckt.coinIds.includes(coinId)) {
                    return false;
                }

                const coins: providerTypes.CoinState[] = rPckt.coinStates.filter((cs) => Util.coin.getId(cs.coin) === coinId);
                callback(coins);

                return true;
            },
            deleteAfterFirstMessageConsumed: false,
            expectedMaxRensponseWait: 0
        });
    }

    public async getPuzzleSolution({coinId, height}: getPuzzleSolutionArgs): Promise<providerTypes.Optional<providerTypes.PuzzleSolution>> {
        coinId = addressUtil.validateHashString(coinId);
        if(coinId.length === 0) return null;

        const pckt: RequestPuzzleSolution = new RequestPuzzleSolution();
        pckt.coinName = coinId;
        pckt.height = height;

        const msgToSend: Buffer = makeMsg(
            ProtocolMessageTypes.request_puzzle_solution,
            pckt,
        );

        let respPckt: PuzzleSolutionResponse = new PuzzleSolutionResponse();
        let returnNull: boolean = false;
        await this.messageManager.registerFilter({
            messageToSend: msgToSend,
            consumeMessage: (msg: Message) => {
                if(msg.type === ProtocolMessageTypes.reject_puzzle_solution) {
                    const rPckt: RejectPuzzleSolution = Serializer.deserialize(
                        RejectPuzzleSolution,
                        msg.data
                    );
                    
                    if(rPckt.coinName === coinId && rPckt.height === height) {
                        returnNull = true;
                        return true;
                    }
                }

                if(msg.type === ProtocolMessageTypes.respond_puzzle_solution) {
                    const rPckt: RespondPuzzleSolution = Serializer.deserialize(
                        RespondPuzzleSolution,
                        msg.data
                    );

                    if(rPckt.response.coinName === coinId && rPckt.response.height === height) {
                        respPckt = rPckt.response;
                        return true;
                    }
                }

                return false;
            },
        });

        if(returnNull) {
            return null;
        }

        return ProviderUtil.serializerPuzzleSolutionResponseToProviderPuzzleSolution(respPckt);
    }

    public async getCoinChildren({ coinId }: getCoinChildrenArgs): Promise<providerTypes.CoinState[]> {
        coinId = addressUtil.validateHashString(coinId);
        if(coinId.length === 0) return [];

        const pckt: RequestChildren = new RequestChildren();
        pckt.coinName = coinId;

        const msgToSend: Buffer = makeMsg(
            ProtocolMessageTypes.request_children,
            pckt,
        );
        let respPckt: RespondChildren = new RespondChildren();

        await this.messageManager.registerFilter({
            messageToSend: msgToSend,
            consumeMessage: (msg: Message) => {
                if(msg.type !== ProtocolMessageTypes.respond_children) {
                    return false;
                }

                const rPckt: RespondChildren = Serializer.deserialize(RespondChildren, msg.data);
                if(rPckt.coinStates.length === 0 || rPckt.coinStates[0].coin.parentCoinInfo === coinId) {
                    respPckt = rPckt;
                    return true;
                }

                return false;
            },
        });

        const coinStates: providerTypes.CoinState[] = [];

        for(let i = 0;i < respPckt.coinStates.length; ++i) {
            coinStates.push(
                ProviderUtil.serializerCoinStateToProviderCoinState(
                    respPckt.coinStates[i]
                )
            )
        }

        return coinStates;
    }

    public async getBlockHeader({ height }: getBlockHeaderArgs): Promise<providerTypes.Optional<providerTypes.BlockHeader>> {
        const pckt: RequestBlockHeader = new RequestBlockHeader();
        pckt.height = height;

        const msgToSend: Buffer = makeMsg(
            ProtocolMessageTypes.request_block_header,
            pckt,
        );

        let returnNull: boolean = false;
        let respPckt: RespondBlockHeader = new RespondBlockHeader();
        await this.messageManager.registerFilter({
            messageToSend: msgToSend,
            consumeMessage: (msg: Message) => {
                if(msg.type === ProtocolMessageTypes.reject_header_request) {
                    const rPckt: RejectHeaderRequest = Serializer.deserialize(
                        RejectHeaderRequest,
                        msg.data
                    );

                    if(rPckt.height === height) {
                        returnNull = true;
                        return true;
                    }
                }

                if(msg.type === ProtocolMessageTypes.respond_block_header) {
                    const rPckt: RespondBlockHeader = Serializer.deserialize(
                        RespondBlockHeader,
                        msg.data
                    );

                    if(rPckt.headerBlock.rewardChainBlock.height === height) {
                        respPckt = rPckt;
                        return true;
                    }
                }

                return false;
            },
        });

        
        if(returnNull) {
            return null;
        }

        const headerBlock: HeaderBlock = respPckt.headerBlock;
        return ProviderUtil.serializerHeaderBlockToProviderBlockHeader(headerBlock, height);
    }

    public async getBlocksHeaders(
        { startHeight, endHeight }: getBlocksHeadersArgs
    ): Promise<providerTypes.Optional<providerTypes.BlockHeader[]>> {
        const pckt: RequestHeaderBlocks = new RequestHeaderBlocks();
        pckt.startHeight = startHeight;
        pckt.endHeight = endHeight;

        const msgToSend: Buffer = makeMsg(
            ProtocolMessageTypes.request_header_blocks,
            pckt,
        );

        let returnNull: boolean = false;
        let respPckt: RespondHeaderBlocks = new RespondHeaderBlocks();
        await this.messageManager.registerFilter({
            messageToSend: msgToSend,
            consumeMessage: (msg: Message) => {
                if(msg.type === ProtocolMessageTypes.reject_header_blocks) {
                    const rPckt: RejectHeaderBlocks = Serializer.deserialize(
                        RejectHeaderBlocks,
                        msg.data
                    );

                    if(rPckt.startHeight === startHeight && rPckt.endHeight === endHeight) {
                        returnNull = true;
                        return true;
                    }
                }

                if(msg.type === ProtocolMessageTypes.respond_header_blocks) {
                    const rPckt: RespondHeaderBlocks = Serializer.deserialize(
                        RespondHeaderBlocks,
                        msg.data
                    );

                    if(rPckt.startHeight === startHeight && rPckt.endHeight === endHeight) {
                        respPckt = rPckt;
                        return true;
                    }
                }

                return false;
            },
        });
        
        if(returnNull) {
            return null;
        }

        const headers: providerTypes.BlockHeader[] = [];
        for(let i = 0; i < respPckt.headerBlocks.length; ++i) {
            const header: providerTypes.BlockHeader =
                ProviderUtil.serializerHeaderBlockToProviderBlockHeader(
                    respPckt.headerBlocks[i],
                    BigNumber.from(respPckt.startHeight).add(i)
                );

            headers.push(header);
        }

        return headers;
    }

    public async getCoinRemovals({
        height,
        headerHash,
        coinIds = undefined
    }: getCoinRemovalsArgs): Promise<providerTypes.Optional<providerTypes.Coin[]>> {
        headerHash = addressUtil.validateHashString(headerHash);
        if(headerHash.length === 0) return null;

        const parsedCoinIds: string[] = [];
        if(coinIds !== undefined) {
            for(let i = 0;i < coinIds.length; ++i) {
                const parsed: string = addressUtil.validateHashString(coinIds[i]);

                if(parsed.length === 0) return null;
                parsedCoinIds.push(parsed);
            }
        }

        const pckt: RequestRemovals = new RequestRemovals();
        pckt.height = height;
        pckt.headerHash = headerHash;
        pckt.coinNames = coinIds !== undefined ? parsedCoinIds : null;

        const msgToSend: Buffer = makeMsg(
            ProtocolMessageTypes.request_removals,
            pckt
        );

        let returnNull: boolean = false;
        let respPckt: RespondRemovals = new RespondRemovals();
        await this.messageManager.registerFilter({
            messageToSend: msgToSend,
            consumeMessage: (msg: Message) => {
                if(msg.type === ProtocolMessageTypes.reject_removals_request) {
                    const rPckt: RejectRemovalsRequest = Serializer.deserialize(
                        RejectRemovalsRequest,
                        msg.data
                    );

                    if(rPckt.height === height && rPckt.headerHash === headerHash) {
                        returnNull = true;
                        return true;
                    }
                }

                if(msg.type === ProtocolMessageTypes.respond_removals) {
                    const rPckt: RespondRemovals = Serializer.deserialize(
                        RespondRemovals,
                        msg.data
                    );

                    if(rPckt.headerHash === headerHash && rPckt.height === height) {
                        respPckt = rPckt;
                        return true;
                    }
                }

                return false;
            },
        });

        if(returnNull) {
            return null;
        }

        const coins: providerTypes.Coin[] = [];
        for(const key of respPckt.coins.keys()) {
            const thing: [string, providerTypes.Optional<Coin>] = respPckt.coins[key];
            if(thing[1] !== null) {
                coins.push(
                    ProviderUtil.serializerCoinToProviderCoin(thing[1])
                );
            }
        }

        return coins;
    }

    public async getCoinAdditions({
        height,
        headerHash,
        puzzleHashes = undefined
    }: getCoinAdditionsArgs): Promise<providerTypes.Optional<providerTypes.Coin[]>> {
        headerHash = addressUtil.validateHashString(headerHash);
        if(headerHash.length === 0) return null;

        const parsedPuzzleHashes: string[] = [];
        if(puzzleHashes !== undefined) {
            for(let i = 0;i < puzzleHashes.length; ++i) {
                const parsed: string = addressUtil.validateHashString(puzzleHashes[i]);

                if(parsed.length === 0) return null;
                parsedPuzzleHashes.push(parsed);
            }
        }

        const pckt: RequestAdditions = new RequestAdditions();
        pckt.height = height;
        pckt.headerHash = headerHash;
        pckt.puzzleHashes = puzzleHashes !== undefined ? parsedPuzzleHashes : null;

        const msgToSend: Buffer = makeMsg(
            ProtocolMessageTypes.request_additions,
            pckt,
        );

        let returnNull: boolean = false;
        let respPckt: RespondAdditions = new RespondAdditions();
        await this.messageManager.registerFilter({
            messageToSend: msgToSend,
            consumeMessage: (msg: Message) => {
                if(msg.type === ProtocolMessageTypes.reject_additions_request) {
                    const rPckt: RejectAdditionsRequest = Serializer.deserialize(
                        RejectAdditionsRequest,
                        msg.data
                    );

                    if(rPckt.height === height && rPckt.headerHash === headerHash) {
                        returnNull = true;
                        return true;
                    }
                }

                if(msg.type === ProtocolMessageTypes.respond_additions) {
                    const rPckt: RespondAdditions = Serializer.deserialize(
                        RespondAdditions,
                        msg.data
                    );

                    if(rPckt.headerHash === headerHash && rPckt.height === height) {
                        respPckt = rPckt;
                        return true;
                    }
                }

                return false;
            },
        });

        if(returnNull)
            return null;

        const coins: providerTypes.Coin[] = [];
        for(const key of respPckt.coins.keys()) {
            const thing: [string, Coin[]] = respPckt.coins[key];
            const coinArr: Coin[] = thing[1];

            for(let j = 0; j < coinArr.length; ++j) {
                const coin: Coin = coinArr[j];
                coins.push(
                    ProviderUtil.serializerCoinToProviderCoin(coin)
                );
            }
        }

        return coins;
    }

    public getAddress(): Promise<string> {
        throw new Error("LeafletProvider does not implement this method.");
    }

    public transfer(args: transferArgs): Promise<boolean> {
        throw new Error("LeafletProvider does not implement this method.");
    }

    public transferCAT(args: transferCATArgs): Promise<boolean> {
        throw new Error("LeafletProvider does not implement this method.");
    }

    public acceptOffer(args: acceptOfferArgs): Promise<boolean> {
        throw new Error("LeafletProvider does not implement this method.");
    }

    public subscribeToAddressChanges(args: subscribeToAddressChangesArgs): void {
        throw new Error("LeafletProvider does not implement this method.");
    }
}