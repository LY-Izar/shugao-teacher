/* ============================================================
   生物知识树 —— **人教版**，高一 → 高二 → 高三
   ------------------------------------------------------------
   这棵树是给「错题归因」用的：老师批完一道题，要把这道题挂到
   **一个具体到能对上题的知识点**上。所以下面每一章的知识点都写到
   「能挂一道题」的粒度（「光反应与暗反应」「伴性遗传」「种群数量的
   “J”形与“S”形增长」），不写「细胞」「遗传」这种一章一个的大词
   —— 大词挂上去等于没挂。

   结构（详见 `types.ts`，**章节与知识点两层的形状与物理完全一致**）：

     生物 → 教材（年级 + 版本） → 章节 → 知识点

     高一：必修1《分子与细胞》 + 必修2《遗传与进化》          （2019 人教版必修）
     高二：选择性必修1《稳态与调节》 + 选择性必修2《生物与环境》
           + 选择性必修3《生物技术与工程》                    （2019 人教版选择性必修）
     高三：选修1《生物技术实践》 + 选修3《现代生物科技专题》  （课标实验版选修，复习用）

   ⚠️ **id 前缀一律 `bio-`**（见 `types.ts` 的 `ID_PREFIXES`）：
      章节 `bio-ch-<英文短名>`、知识点 `bio-<英文短名>`。
      前缀不是装饰 —— `QuestionMeta.points` 存的是**裸 id**，
      全局表（`POINT_NAME` / `POINT_CHAPTER`）按 id 合并所有学科，
      少一个前缀就可能和别科互相覆盖，而且**不报错**。
      科内也不重（`index.ts` 的 `indexOf` 是"先写的赢"，撞了不抛错）。

   ⚠️ **关键词写"题面上真的会出现、且别科不会出现"的词**：
      「同源染色体」「光反应」「负反馈调节」「限制性核酸内切酶」这类。
      别写「细胞」「遗传」「蛋白质」—— 满篇都是，打标会像没打。
      （打标是 `text.includes(词)` 按词长累计得分，同一个知识点多写几个
       近义说法不会互相削弱，只会更容易命中；所以宁多写具体说法。）

   ⚠️ **章节顺序 = 教材目录顺序**（高一 → 高二 → 高三）。
      版本名一律写 `人教版`；教材名（必修1《分子与细胞》等）写在
      各段分隔注释里，不进 `version` —— `version` 是"同一科多个出版社"
      的筛选维度，不是书名。
   ============================================================ */

import type { KnowledgeTree, Textbook } from './types'

/* ============================ 高一 ============================ */

/** 必修1《分子与细胞》（2019 人教版，高一上） */
const RJB_BX1: Textbook = {
  grade: '高一',
  version: '人教版',
  chapters: [
    {
      id: 'bio-ch-cell-world',
      name: '第1章 走近细胞',
      points: [
        {
          id: 'bio-cell-theory',
          name: '细胞学说及其建立过程',
          keywords: ['细胞学说', '施莱登', '施旺', '一切动植物都由细胞', '魏尔肖', '细胞的发现者'],
        },
        {
          id: 'bio-life-levels',
          name: '生命系统的结构层次与细胞是基本的生命系统',
          keywords: ['生命系统的结构层次', '最基本的生命系统', '种群', '群落', '生态系统', '生物圈', '病毒无细胞结构'],
        },
        {
          id: 'bio-microscope',
          name: '高倍显微镜的使用与观察细胞',
          keywords: ['高倍镜', '低倍镜', '目镜', '物镜', '放大倍数', '视野', '玻片', '装片'],
        },
        {
          id: 'bio-prokaryote-eukaryote',
          name: '原核细胞与真核细胞的比较',
          keywords: ['原核细胞', '真核细胞', '原核生物', '真核生物', '蓝细菌', '蓝藻', '拟核', '细菌细胞'],
        },
        {
          id: 'bio-cell-diversity',
          name: '细胞的多样性与细胞学说的意义',
          keywords: ['细胞的多样性', '细胞的统一性', '细胞的形态结构', '水华', '细胞的生物膜'],
        },
      ],
    },
    {
      id: 'bio-ch-molecules',
      name: '第2章 组成细胞的分子',
      points: [
        {
          id: 'bio-elements',
          name: '组成细胞的元素',
          keywords: ['大量元素', '微量元素', '含量最多的化合物', '含量最多的有机物', '最基本元素', '组成细胞的元素'],
        },
        {
          id: 'bio-water-salt',
          name: '细胞中的水和无机盐',
          keywords: ['自由水', '结合水', '自由水与结合水的比值', '无机盐', '离子的形式', '缺铁贫血', '渗透压'],
        },
        {
          id: 'bio-sugar-lipid',
          name: '糖类与脂质的种类和作用',
          keywords: ['单糖', '二糖', '多糖', '还原糖', '脂肪', '磷脂', '固醇', '胆固醇', '纤维素'],
        },
        {
          id: 'bio-protein',
          name: '蛋白质的结构与功能',
          keywords: ['氨基酸', '脱水缩合', '肽键', '肽链', '空间结构', '蛋白质变性', '结构蛋白'],
        },
        {
          id: 'bio-protein-calc',
          name: '蛋白质的计算（氨基酸数、肽键数、相对分子质量）',
          keywords: ['肽键数', '失去的水分子数', '至少含有的羧基', 'n-m', '相对分子质量', '环状多肽'],
        },
        {
          id: 'bio-nucleic-acid',
          name: '核酸的种类、核苷酸与遗传信息',
          keywords: ['核苷酸', '脱氧核苷酸', '核糖核苷酸', '含氮碱基', '核酸的种类', '遗传信息', 'DNA和RNA的区别'],
        },
        {
          id: 'bio-biomolecule-detect',
          name: '生物组织中有机物的检测',
          keywords: ['斐林试剂', '双缩脲试剂', '苏丹Ⅲ', '苏丹Ⅳ', '砖红色沉淀', '紫色反应', '显微镜观察脂肪'],
        },
      ],
    },
    {
      id: 'bio-ch-structure',
      name: '第3章 细胞的基本结构',
      points: [
        {
          id: 'bio-membrane',
          name: '细胞膜的结构与功能',
          keywords: ['细胞膜', '磷脂双分子层', '流动镶嵌模型', '糖蛋白', '糖被', '细胞识别', '细胞膜的制备'],
        },
        {
          id: 'bio-organelle',
          name: '细胞器之间的分工',
          keywords: ['细胞器', '线粒体', '叶绿体', '核糖体', '内质网', '高尔基体', '溶酶体', '中心体', '液泡', '差速离心'],
        },
        {
          id: 'bio-secretion',
          name: '分泌蛋白的合成运输与生物膜系统',
          keywords: ['分泌蛋白', '囊泡', '生物膜系统', '同位素标记法', '胰腺腺泡细胞', '加工与运输'],
        },
        {
          id: 'bio-nucleus',
          name: '细胞核的结构与功能',
          keywords: ['细胞核', '核膜', '核孔', '核仁', '染色质', '遗传信息库', '控制中心'],
        },
      ],
    },
    {
      id: 'bio-ch-transport',
      name: '第4章 细胞的物质输入和输出',
      points: [
        {
          id: 'bio-passive-transport',
          name: '被动运输（自由扩散与协助扩散）',
          keywords: ['自由扩散', '协助扩散', '被动运输', '顺浓度梯度', '转运蛋白', '载体蛋白', '通道蛋白'],
        },
        {
          id: 'bio-osmosis',
          name: '细胞的吸水和失水与质壁分离',
          keywords: ['渗透作用', '半透膜', '质壁分离', '质壁分离复原', '原生质层', '成熟植物细胞'],
        },
        {
          id: 'bio-active-transport',
          name: '主动运输与胞吞、胞吐',
          keywords: ['主动运输', '逆浓度梯度', '能量供应', '胞吞', '胞吐', '大分子物质'],
        },
        {
          id: 'bio-transport-compare',
          name: '物质跨膜运输方式的比较与影响因素',
          keywords: ['运输方式的判断', '影响运输速率的因素', '氧气浓度对运输的影响', '温度对运输的影响'],
        },
      ],
    },
    {
      id: 'bio-ch-energy',
      name: '第5章 细胞的能量供应和利用',
      points: [
        {
          id: 'bio-enzyme',
          name: '酶的本质与特性',
          keywords: ['酶的本质', '酶的特性', '专一性', '过氧化氢酶', '活化能', '酶促反应速率'],
        },
        {
          id: 'bio-enzyme-factors',
          name: '影响酶活性的因素与相关实验',
          keywords: ['最适温度', '最适pH', '低温抑制', '高温失活', '探究酶的专一性', '对照实验的设计'],
        },
        {
          id: 'bio-atp',
          name: 'ATP 与细胞的能量“货币”',
          keywords: ['ATP', 'ADP', '高能磷酸键', 'ATP的水解', 'ATP的合成', '直接能源物质'],
        },
        {
          id: 'bio-aerobic-respiration',
          name: '有氧呼吸的过程与场所',
          keywords: ['有氧呼吸', '细胞质基质', '线粒体基质', '线粒体内膜', '丙酮酸', '[H]', '氧气的消耗'],
        },
        {
          id: 'bio-anaerobic-respiration',
          name: '无氧呼吸与细胞呼吸原理的应用',
          keywords: ['无氧呼吸', '酒精发酵', '乳酸发酵', '无氧条件', '储存粮食', '低温干燥', '中耕松土'],
        },
        {
          id: 'bio-photosynthesis-history',
          name: '光合作用的探究历程与色素的提取分离',
          keywords: ['光合作用', '叶绿素', '类胡萝卜素', '恩格尔曼', '鲁宾和卡门', '层析液', '纸层析', '无水乙醇'],
        },
        {
          id: 'bio-light-dark-reaction',
          name: '光反应与暗反应（碳反应）',
          keywords: ['光反应', '暗反应', '水的光解', 'NADPH', '三碳化合物', '五碳化合物', 'CO2的固定', 'C3的还原'],
        },
        {
          id: 'bio-photosynthesis-factors',
          name: '影响光合作用的环境因素与曲线分析',
          keywords: ['光合速率', '呼吸速率', '光照强度', 'CO2浓度', '光补偿点', '光饱和点', '净光合'],
        },
        {
          id: 'bio-respiration-photosynthesis',
          name: '细胞呼吸与光合作用的关系及密闭容器分析',
          keywords: ['密闭容器', 'CO2的变化量', '有机物的积累量', '光合作用等于呼吸作用', '昼夜温差'],
        },
      ],
    },
    {
      id: 'bio-ch-cell-life',
      name: '第6章 细胞的生命历程',
      points: [
        {
          id: 'bio-cell-cycle',
          name: '细胞周期与细胞增殖',
          keywords: ['细胞周期', '分裂间期', '分裂期', '间期完成DNA的复制', '着丝粒分裂', '着丝点分裂'],
        },
        {
          id: 'bio-mitosis',
          name: '有丝分裂各时期的特点与图像判断',
          keywords: ['有丝分裂', '前期', '中期', '后期', '末期', '染色体数目', '纺锤体', '赤道板'],
        },
        {
          id: 'bio-meiosis',
          name: '减数分裂与受精作用',
          keywords: ['减数分裂', '同源染色体', '联会', '四分体', '姐妹染色单体', '交叉互换', '受精作用'],
        },
        {
          id: 'bio-differentiation',
          name: '细胞的分化与细胞的全能性',
          keywords: ['细胞分化', '基因的选择性表达', '全能性', '组织培养', '干细胞', '克隆'],
        },
        {
          id: 'bio-cell-aging-cancer',
          name: '细胞的衰老、凋亡与癌变',
          keywords: ['细胞衰老', '细胞凋亡', '细胞坏死', '癌细胞', '原癌基因', '抑癌基因', '糖蛋白减少'],
        },
      ],
    },
  ],
}

/** 必修2《遗传与进化》（2019 人教版，高一下） */
const RJB_BX2: Textbook = {
  grade: '高一',
  version: '人教版',
  chapters: [
    {
      id: 'bio-ch-mendel-one',
      name: '第1章 遗传因子的发现',
      points: [
        {
          id: 'bio-mendel-method',
          name: '孟德尔豌豆杂交实验与人工异花传粉',
          keywords: ['豌豆', '自花传粉', '闭花受粉', '人工异花传粉', '去雄', '套袋', '相对性状'],
        },
        {
          id: 'bio-separation-law',
          name: '一对相对性状的杂交实验与分离定律',
          keywords: ['分离定律', '自交', '测交', '显性性状', '隐性性状', '性状分离', '3:1'],
        },
        {
          id: 'bio-free-combination',
          name: '两对相对性状的杂交实验与自由组合定律',
          keywords: ['自由组合定律', '9:3:3:1', '两对相对性状', '非同源染色体上的非等位基因'],
        },
        {
          id: 'bio-mendel-ratio-variants',
          name: '自由组合定律的特殊比例与解题方法',
          keywords: ['9:3:3:1的变式', '9:7', '15:1', '致死现象', '分解组合法', '配子种类'],
        },
      ],
    },
    {
      id: 'bio-ch-gene-chromosome',
      name: '第2章 基因和染色体的关系',
      points: [
        {
          id: 'bio-sex-determination',
          name: '性别决定与伴性遗传',
          keywords: ['伴性遗传', '伴X染色体隐性遗传', '红绿色盲', '抗维生素D佝偻病', 'XY型', '性别决定'],
        },
        {
          id: 'bio-gene-on-chromosome',
          name: '基因在染色体上与孟德尔定律的现代解释',
          keywords: ['萨顿', '摩尔根', '果蝇', '基因在染色体上', '假说—演绎法', '等位基因'],
        },
        {
          id: 'bio-pedigree',
          name: '遗传系谱图的分析与概率计算',
          keywords: ['系谱图', '遗传方式的判断', '无中生有为隐性', '患病概率', '近亲结婚'],
        },
      ],
    },
    {
      id: 'bio-ch-gene-nature',
      name: '第3章 基因的本质',
      points: [
        {
          id: 'bio-transformation',
          name: '肺炎链球菌转化实验',
          keywords: ['格里菲思', '艾弗里', '肺炎链球菌', '转化因子', 'R型菌', 'S型菌'],
        },
        {
          id: 'bio-phage',
          name: '噬菌体侵染细菌实验',
          keywords: ['噬菌体', '赫尔希', '蔡斯', '放射性同位素标记', '32P', '35S', '搅拌不充分'],
        },
        {
          id: 'bio-dna-structure',
          name: 'DNA 分子的结构',
          keywords: ['双螺旋结构', '碱基互补配对', '磷酸二酯键', '脱氧核糖', '反向平行', 'A=T'],
        },
        {
          id: 'bio-dna-replication',
          name: 'DNA 的复制',
          keywords: ['半保留复制', 'DNA复制', '解旋', 'DNA聚合酶', '复制原点', '边解旋边复制'],
        },
      ],
    },
    {
      id: 'bio-ch-gene-expression',
      name: '第4章 基因的表达',
      points: [
        {
          id: 'bio-transcription',
          name: '转录与 RNA 的种类',
          keywords: ['转录', 'RNA聚合酶', '信使RNA', '转运RNA', '核糖体RNA', '模板链'],
        },
        {
          id: 'bio-translation',
          name: '翻译与密码子、反密码子',
          keywords: ['翻译', '密码子', '反密码子', '遗传密码', '多肽链', '氨基酸的排列顺序'],
        },
        {
          id: 'bio-central-dogma',
          name: '中心法则与基因对性状的控制',
          keywords: ['中心法则', '逆转录', '基因控制性状', '酶的合成', '蛋白质的结构', '基因与性状的数量关系'],
        },
        {
          id: 'bio-epigenetics',
          name: '表观遗传与基因表达的影响因素',
          keywords: ['表观遗传', 'DNA甲基化', '组蛋白修饰', '表观遗传现象', '环境对性状的影响'],
        },
      ],
    },
    {
      id: 'bio-ch-mutation',
      name: '第5章 基因突变及其他变异',
      points: [
        {
          id: 'bio-gene-mutation',
          name: '基因突变',
          keywords: ['基因突变', '碱基的替换', '碱基的增添', '碱基的缺失', '诱变育种', '突变率'],
        },
        {
          id: 'bio-gene-recombination',
          name: '基因重组',
          keywords: ['基因重组', '交叉互换', '自由组合', '重组类型', '基因工程的原理'],
        },
        {
          id: 'bio-chromosome-variation',
          name: '染色体结构变异与数目变异',
          keywords: ['染色体结构变异', '染色体数目变异', '缺失', '重复', '易位', '倒位', '染色体组', '多倍体', '单倍体'],
        },
        {
          id: 'bio-human-genetic-disease',
          name: '人类遗传病的类型与检测预防',
          keywords: ['人类遗传病', '单基因遗传病', '多基因遗传病', '染色体异常遗传病', '遗传咨询', '产前诊断'],
        },
        {
          id: 'bio-breeding',
          name: '杂交育种、诱变育种与单倍体育种',
          keywords: ['杂交育种', '诱变育种', '单倍体育种', '多倍体育种', '花药离体培养', '秋水仙素'],
        },
      ],
    },
    {
      id: 'bio-ch-evolution',
      name: '第6章 生物的进化',
      points: [
        {
          id: 'bio-evolution-theory',
          name: '现代生物进化理论',
          keywords: ['现代生物进化理论', '种群是进化的基本单位', '突变和基因重组', '自然选择', '隔离'],
        },
        {
          id: 'bio-population-genetics',
          name: '种群基因频率的变化与计算',
          keywords: ['基因频率', '基因型频率', '哈代-温伯格', '遗传平衡', '随机交配'],
        },
        {
          id: 'bio-speciation',
          name: '物种形成与共同进化',
          keywords: ['物种', '生殖隔离', '地理隔离', '共同进化', '协同进化', '生物多样性'],
        },
      ],
    },
  ],
}

/* ============================ 高二 ============================ */

/** 选择性必修1《稳态与调节》（2019 人教版，高二上） */
const RJB_XX1: Textbook = {
  grade: '高二',
  version: '人教版',
  chapters: [
    {
      id: 'bio-ch-homeostasis',
      name: '第1章 人体的内环境与稳态',
      points: [
        {
          id: 'bio-internal-environment',
          name: '内环境的组成与理化性质',
          keywords: ['内环境', '血浆', '组织液', '淋巴液', '细胞外液', '渗透压', '酸碱度', '组织水肿'],
        },
        {
          id: 'bio-homeostasis',
          name: '内环境的稳态与调节机制',
          keywords: ['稳态', '神经—体液—免疫调节网络', '负反馈调节', '正反馈', '稳态失调'],
        },
        {
          id: 'bio-homeostasis-experiment',
          name: '模拟生物体维持 pH 稳定的实验',
          keywords: ['维持pH稳定', '缓冲物质', '缓冲对', '生物材料', '自来水和缓冲液'],
        },
      ],
    },
    {
      id: 'bio-ch-neural',
      name: '第2章 神经调节',
      points: [
        {
          id: 'bio-nervous-system',
          name: '神经系统的组成与基本结构',
          keywords: ['中枢神经系统', '外周神经系统', '神经元', '神经胶质细胞', '自主神经系统', '交感神经', '副交感神经'],
        },
        {
          id: 'bio-reflex-arc',
          name: '反射与反射弧',
          keywords: ['反射弧', '感受器', '传入神经', '神经中枢', '效应器', '非条件反射', '条件反射'],
        },
        {
          id: 'bio-nerve-impulse',
          name: '兴奋在神经纤维上的传导',
          keywords: ['静息电位', '动作电位', '钠离子内流', '钾离子外流', '局部电流', '双向传导', '电位变化曲线'],
        },
        {
          id: 'bio-synapse',
          name: '兴奋在神经元之间的传递',
          keywords: ['突触', '突触前膜', '突触间隙', '神经递质', '单向传递', '突触后膜', '兴奋性递质'],
        },
        {
          id: 'bio-higher-brain',
          name: '神经系统的分级调节与人脑的高级功能',
          keywords: ['大脑皮层', '言语区', '第一信号系统', '第二信号系统', '学习和记忆', '情绪'],
        },
      ],
    },
    {
      id: 'bio-ch-humoral',
      name: '第3章 体液调节',
      points: [
        {
          id: 'bio-hormone-discovery',
          name: '激素与激素调节的发现',
          keywords: ['促胰液素', '激素调节', '沃泰默', '斯他林', '贝利斯', '内分泌腺'],
        },
        {
          id: 'bio-endocrine-glands',
          name: '人体主要内分泌腺与激素的作用',
          keywords: ['甲状腺激素', '生长激素', '胰岛素', '胰高血糖素', '性激素', '肾上腺素', '分级调节', '反馈调节'],
        },
        {
          id: 'bio-blood-sugar',
          name: '血糖平衡的调节',
          keywords: ['血糖平衡', '胰岛素降低血糖', '胰高血糖素升高血糖', '糖尿病', '尿糖', '肝糖原分解'],
        },
        {
          id: 'bio-temperature-water',
          name: '体温调节与水盐平衡调节',
          keywords: ['体温调节', '产热', '散热', '下丘脑', '抗利尿激素', '水盐平衡', '醛固酮', '渴觉'],
        },
        {
          id: 'bio-neuro-humoral',
          name: '神经调节与体液调节的关系',
          keywords: ['神经调节和体液调节', '体液调节', '激素分泌的分级调节', '反射弧与激素'],
        },
      ],
    },
    {
      id: 'bio-ch-immune',
      name: '第4章 免疫调节',
      points: [
        {
          id: 'bio-immune-system',
          name: '免疫系统的组成与功能',
          keywords: ['免疫系统', '免疫器官', '免疫细胞', '免疫活性物质', '淋巴细胞', '吞噬细胞', '抗原呈递'],
        },
        {
          id: 'bio-innate-immunity',
          name: '非特异性免疫与特异性免疫',
          keywords: ['非特异性免疫', '特异性免疫', '第一道防线', '第二道防线', '第三道防线', '溶菌酶'],
        },
        {
          id: 'bio-humoral-immunity',
          name: '体液免疫',
          keywords: ['体液免疫', '浆细胞', '记忆细胞', '抗体', '辅助性T细胞', '二次免疫'],
        },
        {
          id: 'bio-cellular-immunity',
          name: '细胞免疫',
          keywords: ['细胞免疫', '细胞毒性T细胞', '靶细胞', '靶细胞裂解', '记忆T细胞'],
        },
        {
          id: 'bio-immune-disorder',
          name: '免疫失调与免疫学的应用',
          keywords: ['过敏反应', '自身免疫病', '免疫缺陷病', '艾滋病', '疫苗', '器官移植', '免疫抑制剂'],
        },
      ],
    },
    {
      id: 'bio-ch-plant-hormone',
      name: '第5章 植物生命活动的调节',
      points: [
        {
          id: 'bio-auxin-discovery',
          name: '生长素的发现过程',
          keywords: ['生长素', '达尔文', '鲍森·詹森', '拜尔', '温特', '胚芽鞘', '尖端', '琼脂块'],
        },
        {
          id: 'bio-auxin',
          name: '生长素的生理作用与两重性',
          keywords: ['两重性', '低浓度促进', '高浓度抑制', '顶端优势', '根的向地性', '极性运输', '吲哚乙酸'],
        },
        {
          id: 'bio-other-plant-hormones',
          name: '其他植物激素与植物生长调节剂',
          keywords: ['赤霉素', '细胞分裂素', '脱落酸', '乙烯', '矮壮素', '萘乙酸', '植物生长调节剂'],
        },
        {
          id: 'bio-plant-hormone-experiment',
          name: '植物激素相关的探究实验设计',
          keywords: ['预实验', '浸泡法', '沾蘸法', '探究生长素类似物促进生根的最适浓度', '空白对照'],
        },
      ],
    },
  ],
}

/** 选择性必修2《生物与环境》（2019 人教版，高二下） */
const RJB_XX2: Textbook = {
  grade: '高二',
  version: '人教版',
  chapters: [
    {
      id: 'bio-ch-population',
      name: '第1章 种群及其动态',
      points: [
        {
          id: 'bio-population-density',
          name: '种群密度及其调查方法',
          keywords: ['种群密度', '样方法', '标记重捕法', '五点取样法', '等距取样法', '标志物脱落'],
        },
        {
          id: 'bio-population-features',
          name: '种群的数量特征与空间特征',
          keywords: ['出生率和死亡率', '迁入率和迁出率', '年龄结构', '性别比例', '增长型', '衰退型'],
        },
        {
          id: 'bio-population-growth',
          name: '种群数量的变化（“J”形与“S”形增长）',
          keywords: ['J形增长', 'S形增长', '环境容纳量', 'K值', 'K/2', '增长率', '培养液中酵母菌'],
        },
        {
          id: 'bio-population-factors',
          name: '影响种群数量变化的因素',
          keywords: ['非密度制约因素', '密度制约因素', '食物和天敌', '气候因素', '种群数量的波动'],
        },
      ],
    },
    {
      id: 'bio-ch-community',
      name: '第2章 群落及其演替',
      points: [
        {
          id: 'bio-community-structure',
          name: '群落的物种组成与种间关系',
          keywords: ['物种组成', '丰富度', '互利共生', '捕食', '种间竞争', '寄生', '生态位'],
        },
        {
          id: 'bio-community-space',
          name: '群落的空间结构',
          keywords: ['垂直结构', '水平结构', '分层现象', '镶嵌分布'],
        },
        {
          id: 'bio-succession',
          name: '群落的演替',
          keywords: ['初生演替', '次生演替', '弃耕农田', '火山岩', '人类活动对演替的影响'],
        },
        {
          id: 'bio-soil-animals',
          name: '土壤中小动物类群丰富度的研究',
          keywords: ['土壤小动物', '取样器取样', '丰富度的统计方法', '记名计算法', '目测估计法'],
        },
      ],
    },
    {
      id: 'bio-ch-ecosystem',
      name: '第3章 生态系统及其稳定性',
      points: [
        {
          id: 'bio-ecosystem-structure',
          name: '生态系统的结构',
          keywords: ['生态系统的组成成分', '生产者', '消费者', '分解者', '食物链', '食物网', '营养级'],
        },
        {
          id: 'bio-energy-flow',
          name: '生态系统的能量流动',
          keywords: ['能量流动', '单向流动', '逐级递减', '传递效率', '10%~20%', '摄入量', '同化量', '能量金字塔'],
        },
        {
          id: 'bio-material-cycle',
          name: '生态系统的物质循环',
          keywords: ['物质循环', '碳循环', '全球性', '反复利用', '温室效应', '生物富集'],
        },
        {
          id: 'bio-information-transfer',
          name: '生态系统的信息传递',
          keywords: ['信息传递', '物理信息', '化学信息', '行为信息', '信息素'],
        },
        {
          id: 'bio-ecosystem-stability',
          name: '生态系统的稳定性与生态平衡',
          keywords: ['抵抗力稳定性', '恢复力稳定性', '自我调节能力', '负反馈调节', '生态平衡'],
        },
        {
          id: 'bio-ecosystem-survey',
          name: '生态系统的调查与能量流动的定量计算',
          keywords: ['调查生态系统的组成', '能量传递效率的计算', '下一营养级最多获得', '至少需要'],
        },
      ],
    },
    {
      id: 'bio-ch-human-environment',
      name: '第4章 人与环境',
      points: [
        {
          id: 'bio-population-growth-environment',
          name: '人口增长与生态环境',
          keywords: ['人口增长', '生态足迹', '环境承载力', '资源消耗'],
        },
        {
          id: 'bio-global-issues',
          name: '全球性生态环境问题',
          keywords: ['全球气候变化', '臭氧层破坏', '酸雨', '土地荒漠化', '水体污染', '生物多样性丧失'],
        },
        {
          id: 'bio-biodiversity',
          name: '生物多样性及其保护',
          keywords: ['生物多样性', '就地保护', '易地保护', '自然保护区', '潜在价值', '间接价值'],
        },
        {
          id: 'bio-ecological-engineering',
          name: '生态工程及其原理',
          keywords: ['生态工程', '循环原理', '自生原理', '协调原理', '整体原理', '生态工程建设的目的'],
        },
        {
          id: 'bio-dna-barcode-survey',
          name: '调查环境中的微生物或生物多样性（实践）',
          keywords: ['调查水体中的微生物', '土壤微生物的分解作用', '取样与计数', '实验方案设计'],
        },
      ],
    },
  ],
}

/** 选择性必修3《生物技术与工程》（2019 人教版，高二下 / 高三上） */
const RJB_XX3: Textbook = {
  grade: '高二',
  version: '人教版',
  chapters: [
    {
      id: 'bio-ch-fermentation',
      name: '第1章 发酵工程',
      points: [
        {
          id: 'bio-microbe-culture',
          name: '微生物的基本培养技术',
          keywords: ['培养基', '灭菌', '消毒', '接种', '平板划线法', '稀释涂布平板法', '选择培养基', '菌落'],
        },
        {
          id: 'bio-microbe-count',
          name: '微生物的数量测定与发酵产品的生产',
          keywords: ['活菌计数', '显微镜直接计数', '稀释倍数', '稀释涂布平板法计数', '发酵产品的分离提纯'],
        },
        {
          id: 'bio-fermentation-engineering',
          name: '发酵工程及其应用',
          keywords: ['发酵工程', '发酵罐', '青霉素', '谷氨酸发酵', '菌种的选育', '无菌技术'],
        },
      ],
    },
    {
      id: 'bio-ch-cell-engineering',
      name: '第2章 细胞工程',
      points: [
        {
          id: 'bio-plant-tissue-culture',
          name: '植物组织培养与植物体细胞杂交',
          keywords: ['植物组织培养', '脱分化', '再分化', '愈伤组织', '植物体细胞杂交', '原生质体融合', '人工种子'],
        },
        {
          id: 'bio-animal-cell-culture',
          name: '动物细胞培养与动物细胞融合',
          keywords: ['动物细胞培养', '接触抑制', '传代培养', '动物细胞融合', '杂交瘤细胞', '单克隆抗体'],
        },
        {
          id: 'bio-clone-embryo-stem-cell',
          name: '动物体细胞核移植、克隆与胚胎干细胞',
          keywords: ['核移植', '克隆动物', '体细胞克隆', '胚胎干细胞', '去核卵母细胞', '胚胎工程'],
        },
      ],
    },
    {
      id: 'bio-ch-gene-engineering',
      name: '第3章 基因工程',
      points: [
        {
          id: 'bio-gene-tools',
          name: '基因工程的工具（限制酶、DNA 连接酶、载体）',
          keywords: ['限制性核酸内切酶', '限制酶', 'DNA连接酶', '基因进入受体细胞的载体', '黏性末端', 'Ti质粒'],
        },
        {
          id: 'bio-gene-procedure',
          name: '基因工程的基本操作程序',
          keywords: ['目的基因的获取', 'PCR', '基因表达载体的构建', '启动子', '终止子', '标记基因', '农杆菌转化法', '显微注射', '目的基因的检测与鉴定'],
        },
        {
          id: 'bio-gene-application',
          name: '基因工程的应用与蛋白质工程',
          keywords: ['转基因抗虫棉', '转基因动物', '基因诊断', '基因治疗', '蛋白质工程', '定点突变'],
        },
      ],
    },
    {
      id: 'bio-ch-bioethics',
      name: '第4章 生物技术的安全性与伦理问题',
      points: [
        {
          id: 'bio-gmo-safety',
          name: '转基因技术的安全性与禁止生物武器',
          keywords: ['转基因食品', '生物安全', '禁止生物武器', '《禁止生物武器公约》', '转基因安全性'],
        },
        {
          id: 'bio-reproductive-cloning',
          name: '关注生殖性克隆人与基因编辑的伦理',
          keywords: ['生殖性克隆', '治疗性克隆', '设计试管婴儿', '基因编辑婴儿', '伦理'],
        },
      ],
    },
  ],
}

/* ============================ 高三 ============================ */

/**
 * 选修1《生物技术实践》（课标实验版选修，高三复习用）。
 *
 * ⚠️ 这本书的实验与选择性必修3《生物技术与工程》有重叠（微生物培养、
 *    DNA 提取等），但**设问角度不同**（这里考"操作步骤、结果分析、
 *    对照设置"），所以按专题保留、不合并 —— 合并会让高三的题挂到
 *    高二的知识点上，年级统计就废了。
 */
const RJB_XX1_OLD: Textbook = {
  grade: '高三',
  version: '人教版',
  chapters: [
    {
      id: 'bio-ch-e1-ferment',
      name: '专题1 传统发酵技术的应用',
      points: [
        {
          id: 'bio-e1-fruit-wine',
          name: '果酒与果醋的制作',
          keywords: ['果酒', '果醋', '酵母菌', '醋酸菌', '发酵瓶', '重铬酸钾'],
        },
        {
          id: 'bio-e1-pickled-vegetable',
          name: '腐乳的制作与泡菜中亚硝酸盐的检测',
          keywords: ['腐乳', '毛霉', '亚硝酸盐', '盐酸萘乙二胺', '泡菜', '乳酸菌'],
        },
      ],
    },
    {
      id: 'bio-ch-e1-microbe',
      name: '专题2 微生物的培养与应用',
      points: [
        {
          id: 'bio-e1-medium',
          name: '培养基的配制与无菌技术',
          keywords: ['培养基的配制', '高压蒸汽灭菌', '干热灭菌', '灼烧灭菌', '无菌操作', '倒平板'],
        },
        {
          id: 'bio-e1-isolate-count',
          name: '微生物的分离、纯化与计数',
          keywords: ['平板划线', '稀释涂布', '菌落计数', '活菌计数', '对照实验', '土壤中分解尿素的细菌'],
        },
        {
          id: 'bio-e1-microbe-use',
          name: '分解纤维素的微生物与微生物的利用',
          keywords: ['刚果红染色', '纤维素分解菌', '选择培养', '纤维素的利用'],
        },
      ],
    },
    {
      id: 'bio-ch-e1-enzyme',
      name: '专题3 酶的研究与应用',
      points: [
        {
          id: 'bio-e1-enzyme-immobilize',
          name: '酶的制备、固定化与加酶洗衣粉',
          keywords: ['固定化酶', '固定化细胞', '海藻酸钠', '包埋法', '加酶洗衣粉', '酶的活性探究'],
        },
        {
          id: 'bio-e1-enzyme-activity',
          name: '影响酶活性的实验探究与酶的保存',
          keywords: ['温度对酶活性的影响', 'pH对酶活性的影响', '酶的保存条件', '实验结果分析'],
        },
      ],
    },
    {
      id: 'bio-ch-e1-dna-protein',
      name: '专题4 DNA 和蛋白质技术',
      points: [
        {
          id: 'bio-e1-dna-extract',
          name: 'DNA 的粗提取与鉴定',
          keywords: ['DNA的粗提取', 'DNA鉴定', '二苯胺', '鸡血细胞', 'NaCl溶液', '洗涤剂'],
        },
        {
          id: 'bio-e1-pcr',
          name: 'PCR 技术',
          keywords: ['PCR', '多聚酶链式反应', '变性', '复性', '延伸', 'Taq酶'],
        },
        {
          id: 'bio-e1-protein-electrophoresis',
          name: '血红蛋白的提取、分离与电泳',
          keywords: ['血红蛋白', '凝胶色谱', 'SDS-聚丙烯酰胺', '凝胶电泳', '样品的加入'],
        },
      ],
    },
    {
      id: 'bio-ch-e1-extract',
      name: '专题5 植物有效成分的提取',
      points: [
        {
          id: 'bio-e1-extract-method',
          name: '植物芳香油的提取与水蒸气蒸馏',
          keywords: ['芳香油', '水蒸气蒸馏', '压榨法', '萃取法', '玫瑰精油', '胡萝卜素'],
        },
        {
          id: 'bio-e1-carotene',
          name: '胡萝卜素的提取与鉴定',
          keywords: ['胡萝卜素', '萃取剂', '水浴加热', '纸层析鉴定', '石油醚'],
        },
      ],
    },
    {
      id: 'bio-ch-e1-safety',
      name: '专题6 生物技术实验的安全与规范',
      points: [
        {
          id: 'bio-e1-lab-safety',
          name: '实验室安全与实验方案的评价',
          keywords: ['实验安全', '实验方案评价', '平行重复', '单一变量', '对照原则'],
        },
      ],
    },
  ],
}

/** 选修3《现代生物科技专题》（课标实验版选修，高三复习用） */
const RJB_XX3_OLD: Textbook = {
  grade: '高三',
  version: '人教版',
  chapters: [
    {
      id: 'bio-ch-e3-gene',
      name: '专题1 基因工程',
      points: [
        {
          id: 'bio-e3-gene-tool',
          name: '基因工程的工具与操作程序（复习）',
          keywords: ['基因工程的操作程序', 'DNA重组技术', '基因表达载体', '目的基因的导入'],
        },
        {
          id: 'bio-e3-gene-application',
          name: '基因工程的应用与蛋白质工程（复习）',
          keywords: ['基因工程的应用', '工程菌', '乳腺生物反应器', '蛋白质工程的设计'],
        },
      ],
    },
    {
      id: 'bio-ch-e3-cell',
      name: '专题2 细胞工程',
      points: [
        {
          id: 'bio-e3-plant-cell',
          name: '植物细胞工程（复习）',
          keywords: ['植物细胞工程', '微型繁殖', '作物脱毒', '次生代谢产物', '人工种皮'],
        },
        {
          id: 'bio-e3-animal-cell',
          name: '动物细胞工程（复习）',
          keywords: ['动物细胞工程', '单克隆抗体的制备', '核移植技术', '细胞培养的条件'],
        },
      ],
    },
    {
      id: 'bio-ch-e3-embryo',
      name: '专题3 胚胎工程',
      points: [
        {
          id: 'bio-e3-embryo-basics',
          name: '体内受精与早期胚胎发育',
          keywords: ['体内受精', '精子获能', '卵裂', '桑葚胚', '囊胚', '原肠胚', '孵化'],
        },
        {
          id: 'bio-e3-embryo-tech',
          name: '体外受精、胚胎移植与胚胎分割',
          keywords: ['体外受精', '胚胎移植', '胚胎分割', '同期发情', '超数排卵', '试管牛'],
        },
      ],
    },
    {
      id: 'bio-ch-e3-ecology',
      name: '专题4 生态工程',
      points: [
        {
          id: 'bio-e3-ecology-principle',
          name: '生态工程的基本原理与实例',
          keywords: ['物质循环再生原理', '物种多样性原理', '整体性原理', '无废弃物农业', '桑基鱼塘'],
        },
        {
          id: 'bio-e3-ecology-case',
          name: '生态工程的实例分析',
          keywords: ['农村综合发展型生态工程', '小流域综合治理', '湿地生态恢复', '矿区废弃地的生态恢复'],
        },
      ],
    },
    {
      id: 'bio-ch-e3-ethics',
      name: '专题5 生物技术的安全性和伦理问题',
      points: [
        {
          id: 'bio-e3-biosafety',
          name: '转基因生物的安全性与生物武器',
          keywords: ['转基因生物的安全性', '生物武器的种类', '禁止生物武器', '实质性等同'],
        },
        {
          id: 'bio-e3-ethics',
          name: '生物技术的伦理问题',
          keywords: ['克隆人的伦理', '基因检测与个人隐私', '试管婴儿的伦理', '人类基因组计划'],
        },
      ],
    },
  ],
}

export const BIOLOGY_TREE: KnowledgeTree = {
  subject: 'biology',
  textbooks: [RJB_BX1, RJB_BX2, RJB_XX1, RJB_XX2, RJB_XX3, RJB_XX1_OLD, RJB_XX3_OLD],
}
