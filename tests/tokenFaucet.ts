import * as anchor from '@coral-xyz/anchor';
import { assert } from 'chai';
import { Program } from '@coral-xyz/anchor';
import { TestClient, TokenFaucet } from '../sdk/src';
import { BN } from '../sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import { initializeQuoteSpotMarket, mockUSDCMint } from './testHelpers';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

describe('token faucet', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const program = anchor.workspace.TokenFaucet as Program;

	let tokenFaucet: TokenFaucet;

	let usdcMint: Keypair;

	let token: Token;

	const chProgram = anchor.workspace.Drift as Program;
	let driftClient: TestClient;

	const amount = new BN(10 * 10 ** 6);

	before(async () => {
		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
		});

		usdcMint = await mockUSDCMint(provider);

		tokenFaucet = new TokenFaucet(
			connection,
			provider.wallet,
			program.programId,
			usdcMint.publicKey
		);

		token = new Token(
			connection,
			tokenFaucet.mint,
			TOKEN_PROGRAM_ID,
			// @ts-ignore
			provider.wallet.payer
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('Initialize State', async () => {
		await tokenFaucet.initialize();
		const state: any = await tokenFaucet.fetchState();

		assert.ok(state.admin.equals(provider.wallet.publicKey));

		const [mintAuthority, mintAuthorityNonce] =
			await PublicKey.findProgramAddress(
				[
					Buffer.from(anchor.utils.bytes.utf8.encode('mint_authority')),
					state.mint.toBuffer(),
				],
				tokenFaucet.program.programId
			);

		assert.ok(state.mintAuthority.equals(mintAuthority));
		assert.ok(mintAuthorityNonce === state.mintAuthorityNonce);

		const mintInfo = await token.getMintInfo();
		assert.ok(state.mintAuthority.equals(mintInfo.mintAuthority));
	});

	it('mint to user', async () => {
		const keyPair = new Keypair();
		let userTokenAccountInfo = await token.getOrCreateAssociatedAccountInfo(
			keyPair.publicKey
		);
		try {
			await tokenFaucet.mintToUser(userTokenAccountInfo.address, amount);
		} catch (e) {
			console.error(e);
		}
		userTokenAccountInfo = await token.getOrCreateAssociatedAccountInfo(
			keyPair.publicKey
		);
		assert.ok(userTokenAccountInfo.amount.eq(amount));
	});

	it('initialize user for dev net', async () => {
		const state: any = await tokenFaucet.fetchState();

		await driftClient.initialize(state.mint, false);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.initializeUserAccountForDevnet(
			0,
			'crisp',
			0,
			tokenFaucet,
			amount
		);

		assert(driftClient.getQuoteAssetTokenAmount().eq(amount));
	});

	it('transfer mint authority back', async () => {
		await tokenFaucet.transferMintAuthority();
		const mintInfo = await token.getMintInfo();
		assert.ok(provider.wallet.publicKey.equals(mintInfo.mintAuthority));
	});
});
