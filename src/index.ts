import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import base58 from "bs58";
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} from "@solana/spl-token";

// Загружаем переменные окружения из .env
dotenv.config();

// Используем настройки из переменных окружения или значения по умолчанию
const RPC_URL: string = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const BATCH_SIZE: number = process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE) : 20;
const DELAY_FROM: number = process.env.DELAY_FROM ? parseInt(process.env.DELAY_FROM) : 20;
const DELAY_TO: number = process.env.DELAY_TO ? parseInt(process.env.DELAY_TO) : 180;

const __dirname = path.resolve();

/**
 * Читает файл "solana.txt", где каждая строка – приватный ключ в base58.
 */
const readSolanaWallets = (): string[] =>
  fs
    .readFileSync(path.join(__dirname, "solana.txt"), { encoding: "utf8" })
    .split("\n");

/**
 * Обрабатывает один кошелёк: разбивает пустые SPL-токен аккаунты на батчи,
 * закрывает их, и возвращает количество освобожденных лампортов.
 */
async function closeEmptyTokenAccountsForWallet(
  wallet: Keypair,
  connection: Connection
): Promise<number> {
  console.log(`\nОбработка кошелька: ${wallet.publicKey.toBase58()}`);

  // Получаем все токен-аккаунты, где владелец – данный кошелёк
  const tokenAccountsResponse = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { programId: TOKEN_PROGRAM_ID }
  );

  // Фильтруем аккаунты, у которых баланс равен 0 (uiAmount === 0)
  const emptyTokenAccounts = tokenAccountsResponse.value.filter(
    (tokenAccountInfo) => {
      const parsedInfo: any = tokenAccountInfo.account.data.parsed?.info;
      const tokenAmount = parsedInfo?.tokenAmount;
      return tokenAmount && Number(tokenAmount.uiAmount) === 0;
    }
  );

  console.log(`Найдено пустых токен-аккаунтов: ${emptyTokenAccounts.length}`);

  if (emptyTokenAccounts.length === 0) {
    console.log("Нет пустых токен-аккаунтов для закрытия.");
    return 0;
  }

  // Получаем минимальное количество лампортов, необходимое для освобождения аккаунта (обычно для SPL Token аккаунта размером 165 байт)
  const lamportsPerAccount = await connection.getMinimumBalanceForRentExemption(165);
  let totalRecoveredLamports = 0;

  // Разбиваем список аккаунтов на батчи
  const batches: typeof emptyTokenAccounts[] = [];
  for (let i = 0; i < emptyTokenAccounts.length; i += BATCH_SIZE) {
    batches.push(emptyTokenAccounts.slice(i, i + BATCH_SIZE));
  }
  console.log(`Разбито на ${batches.length} батч(ей) по максимум ${BATCH_SIZE} аккаунтов.`);

  // Обрабатываем каждый батч отдельно
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(`Обработка батча ${batchIndex + 1}/${batches.length} с ${batch.length} аккаунтами.`);

    // Собираем инструкции для текущего батча
    const instructions = batch.map((tokenAccountInfo) => {
      const tokenAccountPubkey = tokenAccountInfo.pubkey;
      return createCloseAccountInstruction(
        tokenAccountPubkey, // Аккаунт, который закрываем
        wallet.publicKey,   // Получатель возвращённых SOL (ваш кошелёк)
        wallet.publicKey,   // Владелец аккаунта
        [],                 // Мультиподписанты (если применимо)
        TOKEN_PROGRAM_ID    // ID токен-программы
      );
    });

    // Логика повторных попыток для отправки транзакции данного батча
    const maxAttempts = 3;
    let attempt = 0;
    let success = false;
    while (!success && attempt < maxAttempts) {
      attempt++;
      try {
        // Получаем свежий blockhash для формирования транзакции
        const latestBlockhash = await connection.getLatestBlockhash("confirmed");

        // Сбор нового сообщения транзакции с актуальным blockhash и инструкциями
        const messageV0 = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: instructions,
        }).compileToV0Message();

        // Создаём версионированную транзакцию и подписываем её
        const vtx = new VersionedTransaction(messageV0);
        vtx.sign([wallet]);

        // Отправляем транзакцию
        const signature = await connection.sendTransaction(vtx);
        console.log(
          `Батч ${batchIndex + 1}: транзакция отправлена: https://solscan.io/tx/${signature}`
        );

        // Подтверждаем транзакцию, используя те же свежие blockhash-параметры
        await connection.confirmTransaction(
          {
            signature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          },
          "confirmed"
        );

        // Вычисляем возвращённые лампорты для этого батча
        const recoveredForBatch = lamportsPerAccount * batch.length;
        console.log(
          `Батч ${batchIndex + 1} успешно обработан: возвращено ${recoveredForBatch} лампортов (~${(
            recoveredForBatch / LAMPORTS_PER_SOL
          ).toFixed(4)} SOL)`
        );
        totalRecoveredLamports += recoveredForBatch;
        success = true;
      } catch (error) {
        console.error(
          `Ошибка при отправке батча ${batchIndex + 1}, попытка ${attempt}/${maxAttempts}:`,
          error
        );
        if (attempt < maxAttempts) {
          const delayMs = 5000; // 5 секунд ожидания перед повторной попыткой
          console.log(`Повторная попытка через ${delayMs / 1000} секунд...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else {
          console.error(
            `Достигнуто максимальное количество попыток для батча ${batchIndex + 1}, этот батч пропускается.`
          );
        }
      }
    }
  }

  return totalRecoveredLamports;
}

/**
 * Основная функция обработки всех кошельков.
 * После обработки каждого кошелька делается случайная задержка (от DELAY_FROM до DELAY_TO секунд).
 * В конце выводится, сколько всего SOL было освобождено.
 */
async function processWallets() {
  // Создаем соединение с RPC, используя значение из переменных окружения
  const rpc = new Connection(RPC_URL, "confirmed");

  // Читаем приватные ключи из файла, убираем пустые строки и лишние пробелы
  const walletLines = readSolanaWallets().filter((line) => line.trim().length > 0);
  const wallets = walletLines.map((line) =>
    Keypair.fromSecretKey(base58.decode(line.trim()))
  );

  console.log(`Найдено кошельков: ${wallets.length}`);
  let totalRecoveredAllLamports = 0;

  for (const wallet of wallets) {
    const recoveredForWallet = await closeEmptyTokenAccountsForWallet(wallet, rpc);
    console.log(
      `Кошелек ${wallet.publicKey.toBase58()} восстановил ${recoveredForWallet} лампортов (~${(
        recoveredForWallet / LAMPORTS_PER_SOL
      ).toFixed(4)} SOL)`
    );
    totalRecoveredAllLamports += recoveredForWallet;

    if (recoveredForWallet > 0) {
      // Задержка между обработкой кошельков: случайное значение от DELAY_FROM до DELAY_TO секунд
      const delaySeconds =
        Math.floor(Math.random() * (DELAY_TO - DELAY_FROM + 1)) + DELAY_FROM;
      console.log(`Ожидание ${delaySeconds} секунд перед обработкой следующего кошелька...`);
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    }
  }

  console.log("\n======================================");
  console.log(
    `Всего освобождено ${totalRecoveredAllLamports} лампортов (~${(
      totalRecoveredAllLamports / LAMPORTS_PER_SOL
    ).toFixed(4)} SOL) со всех кошельков.`
  );
  console.log("======================================\n");
}

processWallets().catch((err) => {
  console.error("Ошибка выполнения:", err);
});
