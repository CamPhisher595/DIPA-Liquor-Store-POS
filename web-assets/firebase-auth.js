(() => {
    const sdkBase = 'https://www.gstatic.com/firebasejs/10.12.2/';
    const emailStorageKey = 'dipa_email_for_signin';
    const requiredConfig = ['apiKey', 'authDomain', 'projectId', 'appId', 'messagingSenderId', 'storageBucket'];
    const authMessage = document.getElementById('authMessage');
    const emailInput = document.getElementById('authEmail');
    const passwordInput = document.getElementById('authPassword');
    const passwordButton = document.getElementById('authPasswordButton');
    const emailLinkButton = document.getElementById('authEmailLinkButton');

    let auth;
    let database;
    let storage;
    let config;
    let storeId;
    let pendingEmailLink = '';
    let sessionVersion = 0;
    let stopListeners = [];
    let catalogWrite = Promise.resolve();

    function setMessage(message, isError = false) {
        authMessage.textContent = message;
        authMessage.classList.toggle('is-error', isError);
    }

    function setBusy(busy) {
        passwordButton.disabled = busy;
        emailLinkButton.disabled = busy;
    }

    function firebaseErrorMessage(error) {
        const code = error && error.code;
        if (code === 'auth/invalid-email') return 'Enter a valid email address.';
        if (code === 'auth/invalid-credential' || code === 'auth/user-not-found' || code === 'auth/wrong-password') {
            return 'The email or password is incorrect.';
        }
        if (code === 'auth/operation-not-allowed') return 'Enable Email/Password and Email link sign-in in Firebase Authentication.';
        if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a little and try again.';
        if (code === 'auth/network-request-failed') return 'Could not reach Firebase. Check your internet connection.';
        if (code === 'auth/expired-action-code' || code === 'auth/invalid-action-code') {
            return 'This sign-in link has expired or was already used. Request a new one.';
        }
        if (code === 'permission-denied' || code === 'firestore/permission-denied') {
            return 'Your account is not authorized for this store. Contact the administrator.';
        }
        return error && error.message ? error.message : 'Sign-in failed. Please try again.';
    }

    function loadScript(name) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = sdkBase + name;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Could not load Firebase SDK: ${name}`));
            document.head.appendChild(script);
        });
    }

    async function loadFirebaseSdk() {
        await loadScript('firebase-app-compat.js');
        await loadScript('firebase-auth-compat.js');
        await loadScript('firebase-firestore-compat.js');
        await loadScript('firebase-storage-compat.js');
    }

    async function seedDocument(reference, initialValue) {
        return database.runTransaction(async transaction => {
            const existing = await transaction.get(reference);
            if (existing.exists) return existing.data();
            transaction.set(reference, initialValue);
            return initialValue;
        });
    }

    function transactionCollection() {
        return database.collection('stores').doc(storeId).collection('transactions');
    }

    function imageReference(path) {
        return storage.ref(`stores/${storeId}/${path}`);
    }

    async function saveTransactions(list) {
        const collection = transactionCollection();
        for (let offset = 0; offset < list.length; offset += 450) {
            const batch = database.batch();
            list.slice(offset, offset + 450).forEach(transaction => {
                if (!transaction || !transaction.id) throw new Error('Transaction is missing its ID.');
                batch.set(collection.doc(String(transaction.id)), transaction);
            });
            await batch.commit();
        }
    }

    async function deleteTransactions() {
        while (true) {
            const snapshot = await transactionCollection().limit(450).get();
            if (snapshot.empty) return;
            const batch = database.batch();
            snapshot.docs.forEach(document => batch.delete(document.ref));
            await batch.commit();
        }
    }

    async function migrateProductImages(canUseLocalData) {
        const localImages = canUseLocalData ? await window.PosApp.getImages() : [];
        const localImagesByPath = new Map(localImages.map(image => [image.path, image]));
        const catalog = window.PosApp.getCatalog();
        const paths = new Set(catalog.products
            .map(product => String(product.image || ''))
            .filter(path => path.startsWith('product-images/')));

        for (const path of paths) {
            const reference = imageReference(path);
            let metadata;
            try {
                metadata = await reference.getMetadata();
            } catch (error) {
                if (error.code !== 'storage/object-not-found') throw error;
                const localImage = localImagesByPath.get(path);
                const source = localImage && localImage.blob instanceof Blob
                    ? localImage.blob
                    : await window.PosApp.getBuiltinImage(path);
                if (!source) continue;
                const uploaded = await reference.put(source, { contentType: source.type || 'image/jpeg' });
                await window.PosApp.cacheImage(path, source, uploaded.metadata.md5Hash);
                continue;
            }

            const localImage = localImagesByPath.get(path);
            if (metadata.md5Hash && localImage?.cloudMd5Hash === metadata.md5Hash) continue;
            const url = await reference.getDownloadURL();
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Image download returned HTTP ${response.status}.`);
            await window.PosApp.cacheImage(path, await response.blob(), metadata.md5Hash);
        }
    }

    async function startStoreSession(nextStoreId, version) {
        await window.PosApp.localDataReady;
        const previousStoreId = localStorage.getItem('dealer_cloud_store_id');
        const canUseLocalData = !previousStoreId || previousStoreId === nextStoreId;
        storeId = nextStoreId;
        const store = database.collection('stores').doc(storeId);
        const localCatalog = canUseLocalData
            ? window.PosApp.getCatalog()
            : window.PosApp.getDefaultCatalog();
        const catalogReference = store.collection('shared').doc('catalog');
        const catalog = await seedDocument(catalogReference, {
            products: localCatalog.products,
            categories: localCatalog.categories,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        if (version !== sessionVersion) return;
        window.PosApp.applyCatalog(catalog);

        const settingsReference = store.collection('shared').doc('settings');
        const settings = await seedDocument(
            settingsReference,
            canUseLocalData ? window.PosApp.getSettings() : {}
        );
        if (version !== sessionVersion) return;
        window.PosApp.applySettings(settings);

        if (!canUseLocalData) await window.PosApp.clearImages();
        const localTransactions = canUseLocalData ? await window.PosApp.getTransactions() : [];
        let remoteTransactions = await transactionCollection().get();
        if (remoteTransactions.empty && localTransactions.length) {
            await saveTransactions(localTransactions);
            remoteTransactions = await transactionCollection().get();
        }
        if (version !== sessionVersion) return;
        await window.PosApp.applyTransactions(remoteTransactions.docs.map(document => document.data()));
        await migrateProductImages(canUseLocalData);
        if (version !== sessionVersion) return;
        localStorage.setItem('dealer_cloud_store_id', storeId);

        stopListeners = [
            catalogReference.onSnapshot(snapshot => {
                if (snapshot.exists && version === sessionVersion) window.PosApp.applyCatalog(snapshot.data());
            }, handleCloudListenerError),
            settingsReference.onSnapshot(snapshot => {
                if (snapshot.exists && version === sessionVersion) window.PosApp.applySettings(snapshot.data());
            }, handleCloudListenerError),
            transactionCollection().onSnapshot(snapshot => {
                if (version !== sessionVersion) return;
                window.PosApp.applyTransactions(snapshot.docs.map(document => document.data()))
                    .catch(handleCloudListenerError);
            }, handleCloudListenerError)
        ];
    }

    function handleCloudListenerError(error) {
        console.error('Shared store synchronization failed.', error);
        window.PosApp.showToast('Could not refresh shared store data. Check your connection.');
    }

    async function completeEmailLink(link) {
        if (!auth || !auth.isSignInWithEmailLink(link)) return false;
        pendingEmailLink = link;
        const email = localStorage.getItem(emailStorageKey) || emailInput.value.trim();
        if (!email) {
            setMessage('Enter the email address that received the sign-in link.', true);
            emailInput.focus();
            return true;
        }

        setBusy(true);
        setMessage('Completing email sign-in…');
        try {
            await auth.signInWithEmailLink(email, link);
            localStorage.removeItem(emailStorageKey);
            pendingEmailLink = '';
            setMessage('Email verified. Signing in…');
        } catch (error) {
            setMessage(firebaseErrorMessage(error), true);
        } finally {
            setBusy(Boolean(auth.currentUser));
        }
        return true;
    }

    async function signInWithPassword() {
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        if (!email || !emailInput.checkValidity() || !password) {
            setMessage('Enter your email and password.', true);
            return;
        }
        setBusy(true);
        setMessage('Signing in…');
        try {
            await auth.signInWithEmailAndPassword(email, password);
        } catch (error) {
            setMessage(firebaseErrorMessage(error), true);
        } finally {
            setBusy(Boolean(auth.currentUser));
        }
    }

    async function sendEmailLink() {
        if (pendingEmailLink) {
            await completeEmailLink(pendingEmailLink);
            return;
        }
        const email = emailInput.value.trim();
        if (!email || !emailInput.checkValidity()) {
            setMessage('Enter a valid email address first.', true);
            emailInput.focus();
            return;
        }
        setBusy(true);
        setMessage('Sending sign-in link…');
        try {
            const actionCodeSettings = {
                url: `https://${config.authDomain}/`,
                handleCodeInApp: true,
                android: {
                    packageName: 'com.dealer.pos',
                    installApp: true,
                    minimumVersion: '7'
                }
            };
            await auth.sendSignInLinkToEmail(email, actionCodeSettings);
            localStorage.setItem(emailStorageKey, email);
            setMessage('Check your email on this device and tap the sign-in link.');
        } catch (error) {
            setMessage(firebaseErrorMessage(error), true);
        } finally {
            setBusy(false);
        }
    }

    async function initialize() {
        setBusy(true);
        setMessage('Connecting to Firebase…');
        try {
            await loadFirebaseSdk();
            const response = await fetch('firebase-config.json', { cache: 'no-store' });
            if (!response.ok) throw new Error(`Firebase config could not be loaded (HTTP ${response.status}).`);
            config = await response.json();
            const missing = requiredConfig.filter(key => !String(config[key] || '').trim());
            if (missing.length) throw new Error(`Firebase config is missing: ${missing.join(', ')}.`);

            const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(config);
            auth = app.auth();
            database = app.firestore();
            storage = app.storage();
            await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

            window.DipaFirebase = {
                profile: null,
                signOut: () => auth.signOut(),
                async saveCatalog(products, categories) {
                    const reference = database.collection('stores').doc(storeId).collection('shared').doc('catalog');
                    catalogWrite = catalogWrite.catch(error => {
                        console.warn('A previous catalog update failed.', error);
                    }).then(() => reference.set({
                        products,
                        categories,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    }));
                    return catalogWrite;
                },
                saveSettings(settings) {
                    return database.collection('stores').doc(storeId).collection('shared').doc('settings').set(settings);
                },
                saveTransaction(transaction) {
                    return transactionCollection().doc(String(transaction.id)).set(transaction);
                },
                saveTransactions,
                async replaceTransactions(list) {
                    await deleteTransactions();
                    await saveTransactions(list);
                },
                async clearTransactions() {
                    await deleteTransactions();
                },
                uploadImage(path, blob) {
                    return imageReference(path).put(blob, { contentType: blob.type });
                },
                async deleteImage(path) {
                    try {
                        await imageReference(path).delete();
                    } catch (error) {
                        if (error.code !== 'storage/object-not-found') throw error;
                    }
                },
                async replaceImages(images) {
                    const retainedPaths = new Set(images.map(image => image.path));
                    const oldImages = await window.PosApp.getImages();
                    await Promise.all(oldImages
                        .filter(image => !retainedPaths.has(image.path))
                        .map(image => this.deleteImage(image.path)));
                    await Promise.all(images.map(image => this.uploadImage(image.path, image.blob)));
                }
            };

            passwordButton.addEventListener('click', signInWithPassword);
            emailLinkButton.addEventListener('click', sendEmailLink);
            passwordInput.addEventListener('keydown', event => {
                if (event.key === 'Enter') signInWithPassword();
            });
            window.handleFirebaseEmailLink = completeEmailLink;

            auth.onAuthStateChanged(async user => {
                const version = ++sessionVersion;
                stopListeners.forEach(stop => stop());
                stopListeners = [];
                document.body.classList.remove('auth-ready');
                if (!user) {
                    window.DipaFirebase.profile = null;
                    storeId = null;
                    return;
                }

                setBusy(true);
                setMessage('Loading your shared store…');
                try {
                    const profileSnapshot = await database.collection('users').doc(user.uid).get();
                    if (version !== sessionVersion) return;
                    if (!profileSnapshot.exists) {
                        await auth.signOut();
                        setMessage('This account is not assigned to a store. Contact your administrator.', true);
                        return;
                    }
                    const profile = profileSnapshot.data();
                    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(profile.storeId || '')) ||
                        !['admin', 'staff'].includes(profile.role)
                    ) {
                        await auth.signOut();
                        setMessage('This account has an invalid store profile. Contact your administrator.', true);
                        return;
                    }

                    profile.email = user.email || '';
                    window.DipaFirebase.profile = profile;
                    window.PosApp.setProfile(profile);
                    await startStoreSession(profile.storeId, version);
                    if (version !== sessionVersion) return;
                    await window.PosApp.renderAuthenticatedApp();
                    if (version !== sessionVersion) return;
                    setMessage('');
                    document.body.classList.add('auth-ready');
                    window.setTimeout(() => window.checkForGithubAppUpdate(), 1800);
                } catch (error) {
                    console.error('Could not initialize the shared store.', error);
                    setMessage(firebaseErrorMessage(error), true);
                } finally {
                    if (version === sessionVersion) setBusy(false);
                }
            });

            const link = window.pendingFirebaseEmailLink || window.location.href;
            if (auth.isSignInWithEmailLink(link)) {
                window.pendingFirebaseEmailLink = '';
                await completeEmailLink(link);
            } else if (!auth.currentUser) {
                setMessage('Sign in with your store account.');
            }
        } catch (error) {
            console.error('Firebase initialization failed.', error);
            setMessage(firebaseErrorMessage(error), true);
        } finally {
            if (!auth || !auth.currentUser) setBusy(false);
        }
    }

    initialize();
})();
