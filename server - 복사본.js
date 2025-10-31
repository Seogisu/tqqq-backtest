const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors'); 
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Yahoo Finance v8 API를 사용하여 주가 데이터 가져오기 (미래 시점 방지 로직 추가)
async function getStockData(ticker, startDate, endDate) {
  try {
    const start = Math.floor(new Date(startDate).getTime() / 1000);
    const end = Math.floor(new Date(endDate).getTime() / 1000);
    
    // 현재 시점보다 미래의 데이터는 요청하지 않도록 조정
    const now = Math.floor(Date.now() / 1000);
    const finalEnd = Math.min(end, now);
    
    if (start > finalEnd) {
      // 조회일이 너무 미래 시점일 경우, 오늘로부터의 데이터 요청
      const today = new Date().toISOString().split('T')[0];
      const newStart = Math.floor(new Date(startDate).getTime() / 1000);
      const newEnd = Math.floor(new Date(today).getTime() / 1000);
      
      if (newStart > newEnd) {
        throw new Error('시작일이 현재 날짜보다 늦거나, 조회일이 너무 미래 시점입니다.');
      }
      
      // 미래 시점을 포함하는 대신, 오늘까지의 데이터로 요청 URL 재구성
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${newStart}&period2=${newEnd}&interval=1d`;
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: 데이터를 가져올 수 없습니다. (조회 기간 조정됨)`);
      }
      
      const json = await response.json();
      
      if (!json.chart || !json.chart.result || json.chart.result.length === 0) {
        throw new Error('종목 코드를 찾을 수 없거나 데이터가 없습니다. 올바른 종목 코드를 입력해주세요.');
      }
      
      const result = json.chart.result[0];
      const timestamps = result.timestamp;
      const closes = result.indicators.quote[0].close;
      
      if (!timestamps || !closes) {
        throw new Error('가격 데이터를 찾을 수 없습니다.');
      }
      
      const data = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] !== null) {
          data.push({
            date: new Date(timestamps[i] * 1000),
            close: closes[i]
          });
        }
      }
      return data.sort((a, b) => a.date - b.date);

    }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${start}&period2=${finalEnd}&interval=1d`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: 데이터를 가져올 수 없습니다.`);
    }
    
    const json = await response.json();
    
    if (!json.chart || !json.chart.result || json.chart.result.length === 0) {
      throw new Error('종목 코드를 찾을 수 없거나 데이터가 없습니다. 올바른 종목 코드를 입력해주세요.');
    }
    
    const result = json.chart.result[0];
    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;
    
    if (!timestamps || !closes) {
      throw new Error('가격 데이터를 찾을 수 없습니다.');
    }
    
    const data = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] !== null) {
        data.push({
          date: new Date(timestamps[i] * 1000),
          close: closes[i]
        });
      }
    }
    
    return data.sort((a, b) => a.date - b.date);
  } catch (error) {
    throw new Error(`${ticker} 데이터 가져오기 실패: ${error.message}`);
  }
}

// 이동평균 계산 
function calculateMA(data, period) {
  const ma = [];
  
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      ma.push(null);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j].close;
      }
      ma.push(sum / period);
    }
  }
  
  return ma;
}

// Helper: 주가가 이동평균선 대비 위(above), 아래(below), 해당없음(any) 조건에 맞는지 확인
function checkCondition(price, ma, condition) {
  if (ma === null) return false;
  if (condition === 'above') return price > ma;
  if (condition === 'below') return price < ma;
  return true; // 'any'
}

// 장 상황 판단 (TQQQ 기준, maConfig 기반)
function determineMarketPhase(tqqqPrice, ma20, ma200, ma1000, maConfig) {
  if (ma20 === null || ma200 === null || ma1000 === null) {
    return 'unknown';
  }
  
  const phases = ['bull', 'bear', 'reentry', 'momentum', 'momentum2']; 

  for (const phaseKey of phases) {
    const config = maConfig[phaseKey];
    if (!config) continue;

    const condition1000 = checkCondition(tqqqPrice, ma1000, config.ma1000);
    const condition200 = checkCondition(tqqqPrice, ma200, config.ma200);
    const condition20 = checkCondition(tqqqPrice, ma20, config.ma20);

    if (condition1000 && condition200 && condition20) {
      return phaseKey;
    }
  }

  return 'unknown'; 
}

function getPhaseKorean(phaseKey) {
  const phaseMap = {
    'bull': '상승장',
    'bear': '하락장',
    'reentry': '재진입',
    'momentum': '모멘텀전환',
    'momentum2': '모멘텀전환2',
    'unknown': '장 상황 미정'
  };
  return phaseMap[phaseKey] || phaseKey;
}

// runAdvancedBacktest 함수 (startIndex 인자 추가 및 로직 보강)
function runAdvancedBacktest(tqqqData, stock1Data, stock2Data, tqqqMA, initialCash, allocation, maConfig, startIndex) {
  let cash = initialCash;
  let stock1Shares = 0;
  let stock2Shares = 0;
  
  const dailyResults = [];
  let lastPhase = null;
  
  for (let i = startIndex; i < tqqqData.length; i++) {
    const tqqqPrice = tqqqData[i].close;
    const stock1Price = stock1Data[i] ? stock1Data[i].close : null;
    const stock2Price = stock2Data[i] ? stock2Data[i].close : null;
    
    // 시뮬레이션 시작 시점 이후 가격이 유효하지 않은 날은 건너뜀
    if (!stock1Price || !stock2Price || stock1Price <= 0 || stock2Price <= 0) continue; 
    
    const ma20 = tqqqMA.ma20[i];
    const ma200 = tqqqMA.ma200[i];
    const ma1000 = tqqqMA.ma1000[i];
    
    const currentPhase = determineMarketPhase(tqqqPrice, ma20, ma200, ma1000, maConfig);
    
    // 핵심 로직: 장 전환 시 또는 시뮬레이션 시작일(i === startIndex)에 리밸런싱/최초 매수 실행
    if (currentPhase !== 'unknown' && (currentPhase !== lastPhase || i === startIndex)) {
      
      const stock1Value = stock1Shares * stock1Price;
      const stock2Value = stock2Shares * stock2Price;
      let totalValue = cash + stock1Value + stock2Value;

      // 1. 모든 자산 현금화 (매도)
      // 시뮬레이션 시작일에는 초기 투자금으로 totalValue가 계산되었으므로 청산하지 않음
      if (i > startIndex) { 
        cash = totalValue; 
      } else {
        // 최초 시작일에는 cash를 초기 투자금으로 설정
        cash = initialCash;
        totalValue = initialCash;
      }
      
      stock1Shares = 0;
      stock2Shares = 0;
      
      // 2. 새로운 배분에 따라 매수
      const phaseAllocation = allocation[currentPhase];
      
      // 현금 비율이 0% 이상인 경우에만 매수 로직 실행
      if (phaseAllocation && phaseAllocation.cash >= 0) {
          
          if (phaseAllocation.stock1 > 0) {
            const stock1Amount = totalValue * (phaseAllocation.stock1 / 100);
            stock1Shares = Math.floor(stock1Amount / stock1Price);
            cash -= stock1Shares * stock1Price;
          }
          
          if (phaseAllocation.stock2 > 0) {
            const stock2Amount = totalValue * (phaseAllocation.stock2 / 100);
            stock2Shares = Math.floor(stock2Amount / stock2Price);
            cash -= stock2Shares * stock2Price;
          }
      }
      
      lastPhase = currentPhase;
    }
    
    // 매일 기록 (MA1000이 유효한 시점부터 기록)
    if (currentPhase !== 'unknown') {
      const stock1Value = stock1Shares * stock1Price;
      const stock2Value = stock2Shares * stock2Price;
      const totalValue = cash + stock1Value + stock2Value;
      const returnRate = ((totalValue - initialCash) / initialCash * 100).toFixed(2); 
      
      dailyResults.push({
        date: tqqqData[i].date.toISOString().split('T')[0],
        dateObj: tqqqData[i].date,
        phase: getPhaseKorean(currentPhase),
        phaseKey: currentPhase, 
        tqqqPrice: parseFloat(tqqqPrice.toFixed(2)),
        stock1Price: parseFloat(stock1Price.toFixed(2)),
        stock1Value: parseFloat(stock1Value.toFixed(2)),
        stock2Price: parseFloat(stock2Price.toFixed(2)),
        stock2Value: parseFloat(stock2Value.toFixed(2)),
        cash: parseFloat(cash.toFixed(2)),
        totalValue: parseFloat(totalValue.toFixed(2)),
        returnRate: parseFloat(returnRate)
      });
    }
  }
  
  return dailyResults;
}

// 월별 데이터 필터링
function getMonthlyResults(dailyResults) {
  const monthlyResults = [];
  
  for (let i = 0; i < dailyResults.length; i++) {
    const isLastDay = i === dailyResults.length - 1;
    const isMonthEnd = isLastDay || 
      (dailyResults[i].dateObj.getMonth() !== dailyResults[i + 1].dateObj.getMonth());
    
    if (isMonthEnd) {
      const result = { ...dailyResults[i] };
      delete result.dateObj;
      monthlyResults.push(result);
    }
  }
  
  return monthlyResults;
}

// 연별 데이터 필터링
function getYearlyResults(dailyResults) {
  const yearlyResults = [];
  
  for (let i = 0; i < dailyResults.length; i++) {
    const isLastDay = i === dailyResults.length - 1;
    const isYearEnd = isLastDay || 
      (dailyResults[i].dateObj.getFullYear() !== dailyResults[i + 1].dateObj.getFullYear());
    
    if (isYearEnd) {
      const result = { ...dailyResults[i] };
      delete result.dateObj;
      yearlyResults.push(result);
    }
  }
  
  return yearlyResults;
}

// API 엔드포인트 - 현재 장 상황 (GET 요청)
app.get('/api/current-phase', async (req, res) => {
    try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1); 
        const endDate = yesterday.toISOString().split('T')[0];

        // MA1000 계산을 위해 충분한 기간(1500일) 데이터 요청
        const startDate = new Date();
        startDate.setDate(today.getDate() - 1500); 
        const startDateString = startDate.toISOString().split('T')[0];
        
        const tqqqData = await getStockData('TQQQ', startDateString, endDate);
        
        if (tqqqData.length < 1000) {
             return res.json({ 
                 success: false,
                 phaseKey: 'unknown', 
                 message: `MA1000 계산을 위한 데이터(${tqqqData.length}일)가 부족합니다.`,
            });
        }
        
        // TQQQ 이동평균 계산
        const tqqqMA = {
            ma20: calculateMA(tqqqData, 20),
            ma200: calculateMA(tqqqData, 200),
            ma1000: calculateMA(tqqqData, 1000)
        };
        
        // 최신 데이터 포인트
        const latestIndex = tqqqData.length - 1;
        const tqqqPrice = tqqqData[latestIndex].close;
        const ma20 = tqqqMA.ma20[latestIndex];
        const ma200 = tqqqMA.ma200[latestIndex];
        const ma1000 = tqqqMA.ma1000[latestIndex];
        const latestDate = tqqqData[latestIndex].date.toISOString().split('T')[0];

        // 장 구분 기준 설정 (프론트엔드의 디폴트 설정을 반영)
        // 백테스트 설정과 독립적으로 작동해야 하므로, 여기에 디폴트 설정을 하드코딩합니다.
        const defaultMaConfig = {
            bull: { ma1000: 'any', ma200: 'above', ma20: 'any' },
            bear: { ma1000: 'any', ma200: 'below', ma20: 'any' },
            reentry: { ma1000: 'below', ma200: 'below', ma20: 'below' },
            momentum: { ma1000: 'above', ma200: 'below', ma20: 'above' }, 
            momentum2: { ma1000: 'below', ma200: 'above', ma20: 'above' }
        };
        
        if (ma1000 === null) {
            return res.json({
                success: false,
                phaseKey: 'unknown',
                message: 'MA1000 계산을 위한 데이터가 부족합니다.'
            });
        }
        
        const phaseKey = determineMarketPhase(tqqqPrice, ma20, ma200, ma1000, defaultMaConfig);

        res.json({
            success: true,
            phaseKey,
            phaseName: getPhaseKorean(phaseKey),
            date: latestDate,
            tqqqPrice: tqqqPrice.toFixed(2), 
            ma20: ma20 ? ma20.toFixed(2) : 'N/A',
            ma200: ma200 ? ma200.toFixed(2) : 'N/A',
            ma1000: ma1000 ? ma1000.toFixed(2) : 'N/A'
        });

    } catch (error) {
        console.error('현재 장 상황 확인 오류:', error);
        res.status(500).json({ 
            success: false,
            phaseKey: 'error',
            message: error.message 
        });
    }
});


// API 엔드포인트 - 고급 백테스트
app.post('/api/advanced-backtest', async (req, res) => {
  try {
    const { startDate, endDate, initialCash, stock1Ticker, stock2Ticker, allocation, maConfig } = req.body;
    
    if (!startDate || !endDate || !initialCash || !stock1Ticker || !stock2Ticker || !maConfig) {
      return res.status(400).json({ success: false, error: '모든 필드를 입력해주세요.' });
    }
    
    // MA 계산을 위해 과거 데이터 포함하여 데이터 가져오기 (1500일 추가)
    const fetchStartDate = new Date(startDate);
    fetchStartDate.setDate(fetchStartDate.getDate() - 1500); 
    const fetchStartDateStr = fetchStartDate.toISOString().split('T')[0];
    
    const [tqqqData, stock1Data, stock2Data] = await Promise.all([
      getStockData('TQQQ', fetchStartDateStr, endDate),
      getStockData(stock1Ticker, fetchStartDateStr, endDate),
      getStockData(stock2Ticker, fetchStartDateStr, endDate)
    ]);
    
    if (tqqqData.length < 1000) {
        throw new Error(`MA1000 계산에 필요한 최소 데이터(1000일)가 부족합니다. 데이터 수: ${tqqqData.length}일. 시작일을 ${Math.ceil(1000 / 252)}년 더 과거로 설정해주세요.`);
    }

    // 날짜 동기화 및 MA 계산 로직
    const syncedStock1Data = [];
    const syncedStock2Data = [];
    
    for (let i = 0; i < tqqqData.length; i++) {
      const targetDate = tqqqData[i].date.toDateString();
      
      const stock1Match = stock1Data.find(d => d.date.toDateString() === targetDate);
      const stock2Match = stock2Data.find(d => d.date.toDateString() === targetDate);
      
      // 데이터가 없는 경우, 이전 날짜의 종가 사용 (또는 최초에는 0)
      const stock1Close = stock1Match ? stock1Match.close : (syncedStock1Data[i-1]?.close || 0);
      const stock2Close = stock2Match ? stock2Match.close : (syncedStock2Data[i-1]?.close || 0);

      syncedStock1Data.push({ date: tqqqData[i].date, close: stock1Close });
      syncedStock2Data.push({ date: tqqqData[i].date, close: stock2Close });
    }
    
    const tqqqMA = {
      ma20: calculateMA(tqqqData, 20),
      ma200: calculateMA(tqqqData, 200),
      ma1000: calculateMA(tqqqData, 1000)
    };
    
    // 시뮬레이션 실제 시작 인덱스 계산
    const maValidIndex = 999; 
    const userStartIndex = tqqqData.findIndex(d => d.date.toISOString().split('T')[0] === startDate);
    
    if (userStartIndex === -1) {
        throw new Error(`요청하신 시작일(${startDate})의 주가 데이터가 존재하지 않습니다.`);
    }

    const stock1FirstValidIndex = syncedStock1Data.findIndex(d => d.close > 0);
    const stock2FirstValidIndex = syncedStock2Data.findIndex(d => d.close > 0);

    if (stock1FirstValidIndex === -1 || stock1FirstValidIndex >= tqqqData.length) {
         throw new Error(`${stock1Ticker}의 유효한 주가 데이터가 백테스트 기간 내에 존재하지 않습니다. 종목 코드를 확인하거나 시작일을 변경해주세요.`);
    }
    if (stock2FirstValidIndex === -1 || stock2FirstValidIndex >= tqqqData.length) {
         throw new Error(`${stock2Ticker}의 유효한 주가 데이터가 백테스트 기간 내에 존재하지 않습니다. 종목 코드를 확인하거나 시작일을 변경해주세요.`);
    }

    const actualStartIndex = Math.max(maValidIndex, userStartIndex, stock1FirstValidIndex, stock2FirstValidIndex);
    
    if (actualStartIndex >= tqqqData.length) {
         throw new Error('시작일이 너무 늦거나, 백테스트 기간이 너무 짧아 시뮬레이션 가능한 날이 없습니다.');
    }

    // 백테스트 실행
    const dailyResults = runAdvancedBacktest(
      tqqqData, 
      syncedStock1Data, 
      syncedStock2Data, 
      tqqqMA, 
      parseFloat(initialCash),
      allocation,
      maConfig,
      actualStartIndex 
    );
    
    if (dailyResults.length === 0) {
      throw new Error('백테스트 결과가 없습니다. 시뮬레이션 가능한 날짜가 없습니다.');
    }
    
    const monthlyResults = getMonthlyResults(dailyResults);
    const yearlyResults = getYearlyResults(dailyResults);
    
    const cleanDailyResults = dailyResults.map(result => {
      const clean = { ...result };
      delete clean.dateObj;
      return clean;
    });
    
    const finalResult = dailyResults[dailyResults.length - 1];
    const initialResult = dailyResults[0]; // 실제 시뮬레이션 시작일의 결과

    // Stock1 주가 상승률 계산 및 summary에 포함
    const startPrice = initialResult.stock1Price;
    const endPrice = finalResult.stock1Price;
    
    let stock1PriceReturn = 0;
    if (startPrice > 0) {
      stock1PriceReturn = (((endPrice - startPrice) / startPrice) * 100).toFixed(2);
    }
    
    const totalReturn = ((finalResult.totalValue - initialCash) / initialCash * 100).toFixed(2);
    
    res.json({
      success: true,
      startDate: initialResult.date, // 실제 시뮬레이션 시작일로 업데이트
      endDate: finalResult.date, // 실제 시뮬레이션 종료일로 업데이트
      initialCash: parseFloat(initialCash),
      stock1Ticker,
      stock2Ticker,
      dataPoints: tqqqData.length,
      dailyResults: cleanDailyResults,
      monthlyResults: monthlyResults,
      yearlyResults: yearlyResults,
      summary: {
        finalValue: finalResult.totalValue,
        totalReturn: parseFloat(totalReturn),
        profit: parseFloat((finalResult.totalValue - initialCash).toFixed(2)),
        // 추가된 필드
        stock1PriceReturn: parseFloat(stock1PriceReturn),
        stock1StartPrice: startPrice,
        stock1EndPrice: endPrice
      }
    });

  } catch (error) {
    console.error('백테스트 오류:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// 메인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`서버가 http://localhost:${PORT} 에서 실행중입니다.`);
});