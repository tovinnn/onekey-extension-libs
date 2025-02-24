const { EventEmitter } = require('events')
const ethUtil = require('ethereumjs-util')
const Transaction = require('ethereumjs-tx')
const HDKey = require('hdkey')
const TrezorConnect = require('@onekeyfe/connect').default

const hdPathString = `m/44'/60'/0'/0`
const keyringType = 'Trezor Hardware'
const pathBase = 'm'
const MAX_INDEX = 1000
const DELAY_BETWEEN_POPUPS = 1000
const TREZOR_CONNECT_MANIFEST = {
  email: 'hi@onekey.so',
  appUrl: 'https://www.onekey.so',
}
class TrezorKeyring extends EventEmitter {

  constructor (opts = {}) {
    super()
    this.type = keyringType
    this.accounts = []
    this.hdk = new HDKey()
    this.page = 0
    this.perPage = 5
    this.unlockedAccount = 0
    this.paths = {}
    this.deserialize(opts)
    // DO NOT init manifest here, let the Application layer call OneKeyKeyring.connect.init() instead.
    // TrezorConnect.manifest(TREZOR_CONNECT_MANIFEST)
  }

  serialize () {
    return Promise.resolve({
      hdPath: this.hdPath,
      accounts: this.accounts,
      page: this.page,
      paths: this.paths,
      perPage: this.perPage,
      unlockedAccount: this.unlockedAccount,
    })
  }

  deserialize (opts = {}) {
    this.hdPath = opts.hdPath || hdPathString
    this.accounts = opts.accounts || []
    this.page = opts.page || 0
    this.perPage = opts.perPage || 5
    return Promise.resolve()
  }

  isUnlocked () {
    return Boolean(this.hdk && this.hdk.publicKey)
  }

  unlock () {
    if (this.isUnlocked()) {
      return Promise.resolve('already unlocked')
    }
    return new Promise((resolve, reject) => {
      try {
        TrezorConnect.getPublicKey({
          path: this.hdPath,
          coin: 'ETH',
        }).then((response) => {
          if (response.success) {
            this.hdk.publicKey = Buffer.from(response.payload.publicKey, 'hex')
            this.hdk.chainCode = Buffer.from(response.payload.chainCode, 'hex')
            resolve('just unlocked')
          } else {
            reject(new Error((response.payload && response.payload.error) || 'Unknown error'))
          }
        }).catch((e) => {
          reject(new Error((e && e.toString()) || 'Unknown error'))
        })
      } catch(e) {
        reject(new Error((e && e.toString()) || 'Unknown error'))
      }
    })
  }

  setAccountToUnlock (index) {
    this.unlockedAccount = parseInt(index, 10)
  }

  addAccounts (n = 1) {
    return new Promise((resolve, reject) => {
      this.unlock()
        .then((_) => {
          const from = this.unlockedAccount
          const to = from + n

          for (let i = from; i < to; i++) {
            const address = this._addressFromIndex(pathBase, i)
            if (!this.accounts.includes(address)) {
              this.accounts.push(address)
            }
            this.page = 0
          }
          resolve(this.accounts)
        })
        .catch((e) => {
          reject(e)
        })
    })
  }

  getFirstPage () {
    this.page = 0
    return this.__getPage(1)
  }

  getNextPage () {
    return this.__getPage(1)
  }

  getPreviousPage () {
    return this.__getPage(-1)
  }

  __getPage (increment) {
    this.page += increment

    if (this.page <= 0) {
      this.page = 1
    }

    return new Promise((resolve, reject) => {
      this.unlock()
        .then((_) => {

          const from = (this.page - 1) * this.perPage
          const to = from + this.perPage

          const accounts = []

          for (let i = from; i < to; i++) {
            const address = this._addressFromIndex(pathBase, i)
            accounts.push({
              address,
              balance: null,
              index: i,
            })
            this.paths[ethUtil.toChecksumAddress(address)] = i

          }
          resolve(accounts)
        })
        .catch((e) => {
          reject(e)
        })
    })
  }

  getAccounts () {
    return Promise.resolve(this.accounts.slice())
  }

  removeAccount (address) {
    if (!this.accounts.map((a) => a.toLowerCase()).includes(address.toLowerCase())) {
      throw new Error(`Address ${address} not found in this keyring`)
    }
    this.accounts = this.accounts.filter((a) => a.toLowerCase() !== address.toLowerCase())
  }

  // tx is an instance of the ethereumjs-transaction class.
  signTransaction (address, tx) {
    return new Promise((resolve, reject) => {
      this.unlock()
        .then((status) => {
          setTimeout((_) => {
            try {
              TrezorConnect.ethereumSignTransaction({
                path: this._pathFromAddress(address),
                transaction: {
                  to: this._normalize(tx.to),
                  value: this._normalize(tx.value),
                  data: this._normalize(tx.data),
                  chainId: tx._chainId,
                  nonce: this._normalize(tx.nonce),
                  gasLimit: this._normalize(tx.gasLimit),
                  gasPrice: this._normalize(tx.gasPrice),
                },
              }).then((response) => {
                if (response.success) {
                  tx.v = response.payload.v
                  tx.r = response.payload.r
                  tx.s = response.payload.s

                  const signedTx = new Transaction(tx)

                  const addressSignedWith = ethUtil.toChecksumAddress(`0x${signedTx.from.toString('hex')}`)
                  const correctAddress = ethUtil.toChecksumAddress(address)
                  if (addressSignedWith !== correctAddress) {
                    reject(new Error('签名的 OneKey 设备与绑定的 OneKey 账户不是同一个设备，请确认后重试！'))
                  }

                  resolve(signedTx)
                } else {
                  reject(new Error((response.payload && response.payload.error) || 'Unknown error'))
                }
              }).catch((e) => {
                reject(new Error((e && e.toString()) || 'Unknown error'))
              })
            } catch (e) {
              // 上面的 this._pathFromAddress 可能会扔出错误, 没有被catch, promise 就一直在pending
              reject(new Error((e && e.toString()) || 'Unknown error'))
            }
            // This is necessary to avoid popup collision
            // between the unlock & sign trezor popups
          }, status === 'just unlocked' ? DELAY_BETWEEN_POPUPS : 0)

        }).catch((e) => {
          reject(new Error((e && e.toString()) || 'Unknown error'))
        })
    })
  }

  signMessage (withAccount, data) {
    return this.signPersonalMessage(withAccount, data)
  }

  // For personal_sign, we need to prefix the message:
  signPersonalMessage (withAccount, message) {
    return new Promise((resolve, reject) => {
      this.unlock()
        .then((status) => {
          setTimeout((_) => {
            try {
              TrezorConnect.ethereumSignMessage({
                path: this._pathFromAddress(withAccount),
                message: ethUtil.stripHexPrefix(message),
                hex: true,
              }).then((response) => {
                if (response.success) {
                  if (response.payload.address !== ethUtil.toChecksumAddress(withAccount)) {
                    reject(new Error('signature doesnt match the right address'))
                  }
                  const signature = `0x${response.payload.signature}`
                  resolve(signature)
                } else {
                  reject(new Error((response.payload && response.payload.error) || 'Unknown error'))
                }
              }).catch((e) => {
                console.log('Error while trying to sign a message ', e)
                reject(new Error((e && e.toString()) || 'Unknown error'))
              })
            } catch (e) {
              reject(new Error((e && e.toString()) || 'Unknown error'))
            }
            // This is necessary to avoid popup collision
            // between the unlock & sign trezor popups
          }, status === 'just unlocked' ? DELAY_BETWEEN_POPUPS : 0)
        }).catch((e) => {
          console.log('Error while trying to sign a message ', e)
          reject(new Error((e && e.toString()) || 'Unknown error'))
        })
    })
  }

  // check eth-simple-keyring signTypedData (withAccount, typedData, opts = { version: 'V1' })
  // https://github.com/MetaMask/eth-sig-util/blob/89c9f91018ff755cefa2d71182426f3659c63a77/src/index.ts#L339
  signTypedData (address, data, opts) {
    // TypedDataUtils.eip712Hash(msgParams.data, version)
    const { version = 'V1' } = opts;
    switch (opts.version) {
      case 'V1':
        return this.signTypedData_v1(address, data, opts);
      case 'V3':
        return this.signTypedData_v3_v4(address, data, opts);
      case 'V4':
        return this.signTypedData_v3_v4(address, data, opts);
      default:
        return this.signTypedData_v1(address, data, opts);
    }
  }

  signTypedData_v1 (address, typedData, opts = {}) {
    // Waiting on trezor to enable this
    return Promise.reject(new Error('Not supported on this device'));
  }

  // personal_signTypedData, signs data along with the schema
  signTypedData_v3_v4 (address, typedData, opts = {}) {
    return new Promise((resolve, reject) => {
      const { version = 'V1' } = opts;
      this.unlock()
        .then((status) => {
          setTimeout((_) => {
            try {
              TrezorConnect.ethereumSignMessageEIP712({
                path: this._pathFromAddress(address),
                version,
                data: typedData,
              }).then((response) => {
                if (response.success) {
                  if (response.payload.address !== ethUtil.toChecksumAddress(address)) {
                    reject(new Error('signature doesnt match the right address'))
                  }
                  const signature = `0x${response.payload.signature}`
                  resolve(signature)
                } else {
                  let code = (response.payload && response.payload.code) || '';
                  const message  = (response.payload && response.payload.error) || '';
                  let errorMsg = (response.payload && response.payload.error) || 'Unknown error';

                  let errorUrl = '';
                  if (message.includes('EIP712Domain')) {
                    code='EIP712_DOMAIN_NOT_SUPPORT'
                  } else if (message.includes('EIP712')) {
                    code='EIP712_BLIND_SIGN_DISABLED'
                    errorUrl = 'https://help.onekey.so/hc/zh-cn/articles/4406637762959'
                  }
                  if (code==='Failure_UnexpectedMessage') {
                    code='EIP712_FIRMWARE_NOT_SUPPORT'
                    errorMsg='Not supported on this device'
                  }
                  const errorCodeI18n = 'connect__ethereumSignMessageEIP712__error__'
                                          + (code || 'Unknown');

                  const error = new Error(errorMsg)
                  error.errorCodeI18n = errorCodeI18n;
                  error.errorUrl = errorUrl;
                  reject(error)
                }
              }).catch((e) => {
                console.log('Error while trying to sign a message ', e)
                reject(new Error((e && e.toString()) || 'Unknown error'))
              })
            } catch (e) {
              reject(new Error((e && e.toString()) || 'Unknown error'))
            }
            // This is necessary to avoid popup collision
            // between the unlock & sign trezor popups
          }, status === 'just unlocked' ? DELAY_BETWEEN_POPUPS : 0)
        }).catch((e) => {
          console.log('Error while trying to sign a message ', e)
          reject(new Error((e && e.toString()) || 'Unknown error'))
        })
    })
  }

  exportAccount () {
    return Promise.reject(new Error('Not supported on this device'))
  }

  forgetDevice () {
    this.accounts = []
    this.hdk = new HDKey()
    this.page = 0
    this.unlockedAccount = 0
    this.paths = {}
  }

  /* PRIVATE METHODS */

  _normalize (buf) {
    return ethUtil.bufferToHex(buf).toString()
  }

  // eslint-disable-next-line no-shadow
  _addressFromIndex (pathBase, i) {
    const dkey = this.hdk.derive(`${pathBase}/${i}`)
    const address = ethUtil
      .publicToAddress(dkey.publicKey, true)
      .toString('hex')
    return ethUtil.toChecksumAddress(`0x${address}`)
  }

  _pathFromAddress (address) {
    const checksummedAddress = ethUtil.toChecksumAddress(address)
    let index = this.paths[checksummedAddress]
    if (typeof index === 'undefined') {
      for (let i = 0; i < MAX_INDEX; i++) {
        if (checksummedAddress === this._addressFromIndex(pathBase, i)) {
          index = i
          break
        }
      }
    }

    if (typeof index === 'undefined') {
      throw new Error('Unknown address')
    }
    return `${this.hdPath}/${index}`
  }
}

TrezorKeyring.type = keyringType
TrezorKeyring.connect = TrezorConnect

module.exports = TrezorKeyring
