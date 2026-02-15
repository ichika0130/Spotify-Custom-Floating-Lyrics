import { LyricManager, TrackInfo } from './LyricManager';

/**
 * 压力测试与缓存验证模块
 * 用于验证 LRU 缓存策略、边界条件及系统稳定性
 */
export class PressureTest {
    
    /**
     * 运行全量测试
     */
    static async run() {
        console.log("=== 开始压力测试 ===");
        
        await this.testCacheBoundary();
        await this.testLRUEviction();
        
        console.log("=== 压力测试完成 ===");
        console.log(LyricManager.getCacheStats());
    }

    /**
     * 测试 1: 缓存边界条件与稳定性
     * 模拟连续写入 50 首歌曲，验证是否报错
     */
    static async testCacheBoundary() {
        console.log("--- 测试阶段 1: 50首歌曲连续写入稳定性 ---");
        const count = 50;
        const errors = [];

        for (let i = 0; i < count; i++) {
            const track: TrackInfo = {
                title: `Test Song ${i}`,
                artist: `Test Artist ${i}`,
                duration: 180
            };
            
            try {
                // 模拟直接写入缓存 (绕过网络请求以避免 API 限制)
                // 使用 any 类型转换访问私有方法 saveToCache
                // 文件名: Test Artist i - Test Song i.lrc
                const filename = `${track.artist} - ${track.title}.lrc`;
                const content = `[00:00.00] Test Lyric Content for ${track.title}`;
                
                await (LyricManager as any).saveToCache(filename, content);
                
                // 立即读取验证
                const result = await LyricManager.getLyrics(track);
                if (!result || !result.includes(track.title)) {
                    errors.push(`Read mismatch for ${track.title}`);
                }
            } catch (e) {
                errors.push(`Error for ${track.title}: ${e}`);
            }
            
            // 每 10 首打印一次进度
            if ((i + 1) % 10 === 0) {
                console.log(`进度: ${i + 1}/${count}`);
            }
        }

        if (errors.length === 0) {
            console.log("✅ 50首歌曲读写测试通过");
        } else {
            console.error("❌ 测试失败:", errors);
        }
    }

    /**
     * 测试 2: LRU 淘汰机制
     * 填充超过 200 首歌曲，验证最早的歌曲是否被删除
     */
    static async testLRUEviction() {
        console.log("--- 测试阶段 2: LRU 缓存淘汰机制 (上限 200) ---");
        
        // 1. 确保缓存已满 (写入 210 首)
        // 前面已经写入了 50 首 (Test Song 0-49)
        // 我们继续写入直到 210
        const totalToWrite = 210;
        
        console.log(`正在填充缓存至 ${totalToWrite} 首...`);
        
        for (let i = 50; i < totalToWrite; i++) {
            const track = {
                title: `Test Song ${i}`,
                artist: `Test Artist ${i}`,
                duration: 180
            };
            const filename = `${track.artist} - ${track.title}.lrc`;
            const content = `[00:00.00] Content ${i}`;
            
            // 故意引入微小延迟以确保 lastAccess 时间戳不同
            await new Promise(r => setTimeout(r, 2));
            await (LyricManager as any).saveToCache(filename, content);
        }

        console.log("填充完成，验证淘汰逻辑...");

        // 2. 验证：最早的歌曲 (Test Song 0) 应该已被删除
        // 因为上限是 200，写入 210 首后，最早的 10 首 (0-9) 应该被淘汰
        const checkIndex = 0; 
        const track0 = {
            title: `Test Song ${checkIndex}`,
            artist: `Test Artist ${checkIndex}`,
            duration: 180
        };
        
        // 注意：loadFromCache 也会更新访问时间，所以我们不能直接调用 getLyrics
        // 我们需要检查它是否还在缓存索引中
        const cacheIndex = (LyricManager as any).cacheIndex as any[];
        const found = cacheIndex.find(item => item.filename === `${track0.artist} - ${track0.title}.lrc`);
        
        if (!found) {
            console.log(`✅ LRU 验证成功: 最早的 'Test Song 0' 已被移除`);
        } else {
            console.error(`❌ LRU 验证失败: 'Test Song 0' 仍然存在`);
        }

        // 3. 验证：最新的歌曲 (Test Song 209) 应该存在
        const lastIndex = 209;
        const trackLast = {
            title: `Test Song ${lastIndex}`,
            artist: `Test Artist ${lastIndex}`,
            duration: 180
        };
        const foundLast = cacheIndex.find(item => item.filename === `${trackLast.artist} - ${trackLast.title}.lrc`);
        
        if (foundLast) {
            console.log(`✅ LRU 验证成功: 最新的 'Test Song ${lastIndex}' 存在`);
        } else {
            console.error(`❌ LRU 验证失败: 'Test Song ${lastIndex}' 丢失`);
        }
        
        console.log(`当前缓存大小: ${cacheIndex.length} (期望: 200)`);
    }
}
