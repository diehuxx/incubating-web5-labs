import * as Block from 'multiformats/block';
import * as CBOR from '@ipld/dag-cbor';

import PouchDB from 'pouchdb';
import pouchFind from 'pouchdb-find';

import { Temporal } from '@js-temporal/polyfill';
import { CID } from 'multiformats';
import { Encoder } from './encoder.js';
import { exporter } from 'ipfs-unixfs-exporter';
import { importer } from 'ipfs-unixfs-importer';
import { sha256 } from 'multiformats/hashes/sha2';
import { Blockstore } from './block-store.js';

PouchDB.plugin(pouchFind);

export class MessageStore {
  #eventLog;
  #messageStore;

  constructor() {
    this.#eventLog = new PouchDB('message-event-log');
    this.#messageStore = new Blockstore('messages');
  }

  async open() {
    if (!this.#messageStore) {
      this.#messageStore = new Blockstore(this.config.blockstoreLocation);
    }

    await this.#messageStore.open();
  }

  async close() {
    await this.#eventLog.close();
    await this.#messageStore.close();
  }

  async get(cid) {
    const bytes = await this.#messageStore.get(cid);

    if (!bytes) {
      return;
    }

    const decodedBlock = await Block.decode({ bytes, codec: CBOR, hasher: sha256 });

    const messageJson = decodedBlock.value;

    if (!messageJson.descriptor['dataCid']) {
      return messageJson;
    }

    // data is chunked into dag-pb unixfs blocks. re-inflate the chunks.
    const dataReferencingMessage = decodedBlock.value;
    const dataCid = CID.parse(dataReferencingMessage.descriptor.dataCid);

    const dataDagRoot = await exporter(dataCid, this.#messageStore);
    const dataBytes = new Uint8Array(dataDagRoot.size);
    let offset = 0;

    for await (const chunk of dataDagRoot.content()) {
      dataBytes.set(chunk, offset);
      offset += chunk.length;
    }

    dataReferencingMessage.encodedData = Encoder.bytesToBase64Url(dataBytes);

    return messageJson;
  }

  async put(messageJson, indexes) {
    // delete `encodedData` if it exists so `messageJson` is stored without it, `encodedData` will be decoded, chunked and stored separately below
    let encodedData = undefined;
    if (messageJson['encodedData'] !== undefined) {
      const messageJsonWithEncodedData = messageJson;
      encodedData = messageJsonWithEncodedData.encodedData;

      delete messageJsonWithEncodedData.encodedData;
    }

    const encodedBlock = await Block.encode({ value: messageJson, codec: CBOR, hasher: sha256 });

    await this.#messageStore.put(encodedBlock.cid, encodedBlock.bytes);

    // if `encodedData` is present we'll decode it then chunk it and store it as unix-fs dag-pb encoded
    if (encodedData) {
      const content = Encoder.base64UrlToBytes(encodedData);
      const chunk = importer([{ content }], this.#messageStore, { cidVersion: 1 });

      // for some reason no-unused-vars doesn't work in for loops. it's not entirely surprising because
      // it does seem a bit strange to iterate over something you never end up using but in this case
      // we really don't have to access the result of `chunk` because it's just outputting every unix-fs
      // entry that's getting written to the blockstore. the last entry contains the root cid
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of chunk) { ; }
    }

    const evResult = await this.#eventLog.put({
      _id: MessageStore.#generateID(),
      messageCid: encodedBlock.cid.toString(),
      ...indexes,
    });
  }

  async query(includeCriteria, excludeCriteria) {
    const { docs } = await this.#eventLog.find({
      selector: {
        ...includeCriteria
      }
    });

    const messages = [];

    for (const result of docs) {
      const cid = CID.parse(result.messageCid);
      const message = await this.get(cid);

      messages.push(message);
    }

    return messages;
  }

  async delete() {
    // TODO: Implement data deletion in Collections - https://github.com/TBD54566975/dwn-sdk-js/issues/84
    await this.#messageStore.delete(cid);
    return;
  }

  /**
   * returns system time as a plain ISO date string with microsecond precision
   * using @js-temporal/polyfill
   */
  static #generateID() {
    return Temporal.Now.instant().epochNanoseconds.toString();
  }
}