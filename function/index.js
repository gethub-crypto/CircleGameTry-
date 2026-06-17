const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// Безопасное добавление очков
exports.addScore = functions.https.onCall(async (data, context) => {
  // Проверка авторизации
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }
  
  const uid = context.auth.uid;
  const { amount, clickPower, timestamp, hash } = data;
  
  // Валидация входных данных
  if (!amount || amount <= 0 || amount > 1000) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid amount');
  }
  
  // Проверка временной метки (не старше 5 секунд)
  const now = Date.now();
  if (Math.abs(now - timestamp) > 5000) {
    throw new functions.https.HttpsError('deadline-exceeded', 'Request too old');
  }
  
  // Rate limiting
  const lastClickSnapshot = await admin.database()
    .ref(`users/${uid}/lastClick`)
    .once('value');
  const lastClick = lastClickSnapshot.val() || 0;
  
  if (now - lastClick < 50) {
    throw new functions.https.HttpsError('resource-exhausted', 'Too many requests');
  }
  
  // Проверка clickPower
  const userSnapshot = await admin.database()
    .ref(`leaderboard/${uid}`)
    .once('value');
  const userData = userSnapshot.val() || {};
  const serverClickPower = userData.clickPower || 1;
  
  if (clickPower > serverClickPower * 2) {
    // Логирование подозрительной активности
    await admin.database().ref(`suspiciousActivity/${uid}`).push({
      type: 'clickPowerMismatch',
      clientClickPower: clickPower,
      serverClickPower,
      timestamp: now
    });
    throw new functions.https.HttpsError('permission-denied', 'Invalid click power');
  }
  
  // Атомарное обновление счета
  const scoreRef = admin.database().ref(`leaderboard/${uid}/score`);
  
  const result = await scoreRef.transaction(currentScore => {
    return (currentScore || 0) + amount;
  });
  
  if (!result.committed) {
    throw new functions.https.HttpsError('aborted', 'Transaction failed');
  }
  
  // Обновление времени последнего клика
  await admin.database().ref(`users/${uid}`).update({
    lastClick: now
  });
  
  // Логирование для аналитики
  await admin.database().ref(`clicks/${uid}`).push({
    amount,
    clickPower: serverClickPower,
    timestamp: now,
    ip: context.rawRequest.ip
  });
  
  return { 
    success: true, 
    newScore: result.snapshot.val() 
  };
});

// Проверка целостности данных
exports.verifyIntegrity = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Auth required');
  }
  
  const uid = context.auth.uid;
  const userSnapshot = await admin.database()
    .ref(`leaderboard/${uid}`)
    .once('value');
  
  const userData = userSnapshot.val();
  
  // Проверка на аномалии
  const checks = {
    scoreOk: userData.score >= 0,
    clickPowerOk: userData.clickPower <= 100,
    noSuspiciousFlags: (userData.suspiciousFlags || 0) < 5
  };
  
  return {
    valid: Object.values(checks).every(v => v),
    checks
  };
});
