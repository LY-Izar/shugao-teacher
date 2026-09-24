/* ============================================================
   英语知识树 —— **外研版（2019 新标准）**，高一 → 高二 → 高三
   ------------------------------------------------------------
   为什么英语也要这棵树：错题集要回答的是「他在哪个知识点上掉分最多」，
   而不是「他错了第 3 题」。英语的难点在于**同一道题会同时踩几个点**
   （一篇读后续写可能同时暴露"时态不一致 + 非谓语作状语 + 情感词汇贫乏"），
   所以知识点必须具体到"能挂一道题上去"的粒度。

   为什么用关键词匹配而不是再调一次 AI：见 `physics.ts` 与 `lib/knowledge.ts`
   头上的说明 —— 完全本机、零成本、可离线。

   ------------------------------------------------------------
   🔴 **本文件的组织方式：一本教材一段，章节 = 教材真实的单元**

     高一：必修第一册 / 必修第二册 / 必修第三册   （三册，各 6 个 Unit）
     高二：选择性必修第一册 / 第二册 / 第三册      （三册，各 6 个 Unit）
     高三：选择性必修第四册 + 高考一轮复习专题      （一册 6 Unit + 4 个复习专题章）

   ⚠️ **章节名用的是教材目录里的单元标题原文**（Unit 1 A new start …），
      没有自己编。单元里的语篇标题（如 My First Day at Senior High、
      Neither Pine Nor Apple in Pineapple）写在**注释**里当索引，
      不占章节名 —— 章节名要能一眼对回课本目录。

   ⚠️ **id 规则（本文件自洽，全文件统一）**：

     章节 id： `eng-ch-<册>-u<单元号>`      例：`eng-ch-g1-u1`
     复习章： `eng-ch-r3-grammar`           （r3 = 高三复习）
     知识点 id：`eng-<册><单元>-<英文短名>`  例：`eng-g1u1-past-continuous`

     册代号： g1/g2/g3 = 高一必修一/二/三
              s1/s2/s3/s4 = 高二高三选择性必修一/二/三/四
              r3 = 高三一轮复习专题
     前缀 `eng-` 必须有（见 `types.ts` 的 `ID_PREFIXES`）：不然两科撞 id
     会互相覆盖而且**不报错**。

   ⚠️ **关键词按"题面上真的长这样"来写**，英语的坑在于 OCR 出来的题面
      英汉混排，所以关键词中英都放：考卷上写 `non-restrictive`、
      `past participle`，也写「非限制性定语从句」「过去分词」。
      **不写 `the` / `a` / `is` 这种满篇都是的词** —— 词越通用，打标越像没打。
      标点是 `!` 的单元名（What an adventure!）关键词里去掉标点，
      因为题面不一定带。
   ============================================================ */

import type { KnowledgeTree, Textbook } from './types'

/* ============================================================
   高一 —— 必修第一册 / 第二册 / 第三册
   ============================================================ */

/** 外研版（2019）必修第一册 —— 高一上 */
const G1: Textbook = {
  grade: '高一',
  version: '外研版',
  chapters: [
    {
      // Unit 1 A new start（Understanding ideas: My First Day at Senior High）
      id: 'eng-ch-g1-u1',
      name: 'Unit 1 A new start',
      points: [
        {
          id: 'eng-g1u1-past-continuous',
          name: '过去进行时（was/were doing … when …）',
          keywords: ['过去进行时', 'was doing', 'were doing', 'was walking', 'when the bell rang'],
        },
        {
          id: 'eng-g1u1-present-perfect',
          name: '现在完成时与 since / for / so far',
          keywords: ['现在完成时', 'have been', 'has been', 'since I', 'so far', 'in the past few years'],
        },
        {
          id: 'eng-g1u1-school-life',
          name: '高中新生活话题词汇（campus / senior / impression / make the most of）',
          keywords: ['senior high', 'campus', 'first impression', 'make the most of', 'after-school activity', 'freshman'],
        },
        {
          id: 'eng-g1u1-journal',
          name: '日记与成长类记叙文写作',
          keywords: ['journal entry', 'diary', 'My First Day at Senior High', 'a new start'],
        },
        {
          id: 'eng-g1u1-phrasal-verb',
          name: '常见动词短语辨析（get on / get over / take up / put up）',
          keywords: ['get on with', 'get over', 'take up', 'put up with', 'look forward to'],
        },
      ],
    },
    {
      // Unit 2 Exploring English（Understanding ideas: Neither Pine Nor Apple in Pineapple）
      id: 'eng-ch-g1-u2',
      name: 'Unit 2 Exploring English',
      points: [
        {
          id: 'eng-g1u2-word-formation',
          name: '构词法：合成、派生与转化',
          keywords: ['构词法', '合成词', '派生', '前缀', '后缀', 'word formation', 'compound word', 'prefix', 'suffix'],
        },
        {
          id: 'eng-g1u2-phrasal-verb',
          name: '短语动词与一词多义（turn up / burn up / go off）',
          keywords: ['短语动词', 'phrasal verb', 'burn up', 'burn down', 'go off', 'turn up', 'fill in', 'fill out'],
        },
        {
          id: 'eng-g1u2-english-varieties',
          name: '英美用词与文化差异（pants / subway / petrol）',
          keywords: ['British English', 'American English', '英式英语', '美式英语', 'subway', 'underground', 'petrol', 'gas station'],
        },
        {
          id: 'eng-g1u2-inversion',
          name: '倒装与否定词前置（Neither is there …）',
          keywords: ['倒装', 'inversion', 'neither is there', 'not only', 'hardly had'],
        },
        {
          id: 'eng-g1u2-word-puzzle',
          name: '趣味语言现象与标题双关解读',
          keywords: ['pineapple', 'Neither Pine Nor Apple', 'crazy language', 'pun', '双关'],
        },
      ],
    },
    {
      // Unit 3 Family matters（Understanding ideas: Like Father, Like Son）
      id: 'eng-ch-g1-u3',
      name: 'Unit 3 Family matters',
      points: [
        {
          id: 'eng-g1u3-present-tenses',
          name: '一般现在时 / 现在进行时 / 一般将来时的用法辨析',
          keywords: ['一般现在时', '现在进行时', '一般将来时', 'present continuous', 'be going to', 'will be doing'],
        },
        {
          id: 'eng-g1u3-family-vocab',
          name: '家庭关系与人物性格、外貌描写词汇',
          keywords: ['family member', 'generation', 'Like Father Like Son', 'personality', 'appearance', 'take after'],
        },
        {
          id: 'eng-g1u3-dialogue',
          name: '情景对话与观点表达（in my opinion / I see your point）',
          keywords: ['in my opinion', 'I see your point', 'as far as I am concerned', 'I agree', 'I am afraid'],
        },
        {
          id: 'eng-g1u3-illocution',
          name: '戏剧冲突与人物台词的言外之意',
          keywords: ['play', 'curtain', 'act', 'scene', 'stage direction', 'conflict', '台词'],
        },
      ],
    },
    {
      // Unit 4 Friends forever（Understanding ideas: Click for a Friend?）
      id: 'eng-ch-g1-u4',
      name: 'Unit 4 Friends forever',
      points: [
        {
          id: 'eng-g1u4-rel-clause',
          name: '定语从句关系代词（who / whom / whose / that / which）',
          keywords: ['定语从句', '关系代词', 'relative pronoun', 'attributive clause', 'the person who', 'in which'],
        },
        {
          id: 'eng-g1u4-prep-rel',
          name: '介词 + 关系代词（with whom / in which）',
          keywords: ['介词+关系代词', 'with whom', 'in which', 'to which', 'of which'],
        },
        {
          id: 'eng-g1u4-have-done',
          name: 'have sth done 使役结构',
          keywords: ['have sth done', 'have my hair cut', 'get sth done', '使役'],
        },
        {
          id: 'eng-g1u4-online-friend',
          name: '网络交友与社交媒体话题词汇',
          keywords: ['online friend', 'Click for a Friend', 'social media', 'chat online', 'digital age', 'make friends'],
        },
        {
          id: 'eng-g1u4-idiom',
          name: '英语习语与推测词义（throw the baby out with the bathwater）',
          keywords: ['idiom', '习语', 'throw the baby out with the bathwater', 'guess the meaning', '上下文猜词'],
        },
        {
          id: 'eng-g1u4-informal',
          name: '非正式文体（论坛帖子 / 网络留言）语言特征',
          keywords: ['forum post', '网络帖子', 'informal', 'contraction', "don't", "I'm"],
        },
      ],
    },
    {
      // Unit 5 Into the wild（Understanding ideas: Monarch Butterflies 帝王蝶迁徙）
      id: 'eng-ch-g1-u5',
      name: 'Unit 5 Into the wild',
      points: [
        {
          id: 'eng-g1u5-animal-vocab',
          name: '动物迁徙与自然话题词汇',
          keywords: ['monarch butterfly', 'migrate', 'migration', '迁徙', 'habitat', 'endangered species', 'wildlife'],
        },
        {
          id: 'eng-g1u5-rel-clause-adv',
          name: '关系副词 where / when / why 与 the reason why',
          keywords: ['关系副词', 'relative adverb', 'the reason why', 'the place where', 'the time when'],
        },
        {
          id: 'eng-g1u5-it',
          name: 'it 作形式主语与形式宾语',
          keywords: ['形式主语', '形式宾语', 'it is important to', 'it takes sb', 'find it hard to'],
        },
        {
          id: 'eng-g1u5-nonrestrictive',
          name: '非限制性定语从句（, which …）',
          keywords: ['非限制性定语从句', 'non-restrictive', 'nonrestrictive', ', which', ', who'],
        },
        {
          id: 'eng-g1u5-cause-effect',
          name: '因果与目的说明文写作（as a result / so that / in order to）',
          keywords: ['as a result', 'so that', 'in order to', 'lead to', 'result in', 'because of'],
        },
      ],
    },
    {
      // Unit 6 At one with nature（Understanding ideas: Longji Rice Terraces 龙脊梯田）
      id: 'eng-ch-g1-u6',
      name: 'Unit 6 At one with nature',
      points: [
        {
          id: 'eng-g1u6-relative-clause-mix',
          name: '定语从句综合（限制性 / 非限制性 / 只能用 that 的情形）',
          keywords: ['定语从句综合', '只能用that', 'the only thing that', 'everything that', 'all that'],
        },
        {
          id: 'eng-g1u6-as-if',
          name: 'as if / as though 与方式状语从句',
          keywords: ['as if', 'as though', '方式状语从句', 'as if it were'],
        },
        {
          id: 'eng-g1u6-landscape',
          name: '自然景观与地理话题词汇',
          keywords: ['terrace', '梯田', 'landscape', 'at one with nature', 'valley', 'natural resource'],
        },
        {
          id: 'eng-g1u6-summary',
          name: '说明文概要写作（summary）',
          keywords: ['写概要', 'summary', 'main idea', '概括', 'topic sentence'],
        },
      ],
    },
  ],
}

/** 外研版（2019）必修第二册 —— 高一下 */
const G2: Textbook = {
  grade: '高一',
  version: '外研版',
  chapters: [
    {
      // Unit 1 Food for thought（Understanding ideas: A Child of Two Cuisines）
      id: 'eng-ch-g2-u1',
      name: 'Unit 1 Food for thought',
      points: [
        {
          id: 'eng-g2u1-present-perfect',
          name: '现在完成时与现在完成进行时',
          keywords: ['现在完成进行时', 'have been doing', 'has been doing', '现在完成时', 'have already'],
        },
        {
          id: 'eng-g2u1-not-only',
          name: 'not only … but also … 与倒装',
          keywords: ['not only but also', 'not only 倒装', 'not only does', 'both and'],
        },
        {
          id: 'eng-g2u1-food-vocab',
          name: '饮食文化与中外菜名话题词汇',
          keywords: ['cuisine', 'stinky tofu', '臭豆腐', 'roast', 'recipe', 'diet', 'traditional Chinese medicine'],
        },
        {
          id: 'eng-g2u1-suffer',
          name: '高频动词辨析（suffer / gather / remind / deal with）',
          keywords: ['suffer from', 'gather courage', 'remind sb of', 'deal with', 'come across'],
        },
        {
          id: 'eng-g2u1-recipe',
          name: '食谱写作（祈使句与顺序词）',
          keywords: ['写食谱', 'recipe', 'First', 'Second', 'finally', 'cut into pieces'],
        },
      ],
    },
    {
      // Unit 2 Let's celebrate!（Understanding ideas: 节日）
      id: 'eng-ch-g2-u2',
      name: "Unit 2 Let's celebrate!",
      points: [
        {
          id: 'eng-g2u2-modals',
          name: '情态动词表推测与可能（must / may / might / can）',
          keywords: ['情态动词', 'must have done', 'may have done', 'might be', 'can not have'],
        },
        {
          id: 'eng-g2u2-passive',
          name: '主动语态与被动语态的转换',
          keywords: ['被动语态', 'passive voice', 'is celebrated', 'was held', 'be decorated with'],
        },
        {
          id: 'eng-g2u2-festival-vocab',
          name: '中外节日与庆祝活动话题词汇',
          keywords: ['festival', 'celebrate', 'let us celebrate', 'Spring Festival', 'Christmas', 'Thanksgiving', 'custom'],
        },
        {
          id: 'eng-g2u2-invitation',
          name: '介绍节日类说明文与邀请写作',
          keywords: ['介绍节日', 'invitation', 'invite sb to', 'I would like to invite', 'fall on'],
        },
      ],
    },
    {
      // Unit 3 On the move（Understanding ideas: 体育运动）
      id: 'eng-ch-g2-u3',
      name: 'Unit 3 On the move',
      points: [
        {
          id: 'eng-g2u3-infinitive',
          name: '动词不定式作主语、宾语与表语',
          keywords: ['不定式', 'infinitive', 'to do', 'it is + adj + to do', 'want to do'],
        },
        {
          id: 'eng-g2u3-gerund',
          name: '动名词作主语与宾语（enjoy doing / look forward to doing）',
          keywords: ['动名词', 'gerund', 'enjoy doing', 'look forward to doing', 'be worth doing'],
        },
        {
          id: 'eng-g2u3-sports-vocab',
          name: '体育运动话题词汇',
          keywords: ['sports', 'athlete', 'on the move', 'marathon', 'tai chi', '太极拳', 'championship'],
        },
        {
          id: 'eng-g2u3-preference',
          name: '喜好与选择表达（would rather / prefer to / would like to）',
          keywords: ['would rather', 'prefer to', 'prefer A to B', 'would like to', 'rather than'],
        },
        {
          id: 'eng-g2u3-narrative',
          name: '体育故事记叙文写作',
          keywords: ['描写体育运动', 'sports story', 'match', 'score a goal', 'break the record'],
        },
      ],
    },
    {
      // Unit 4 Stage and screen（Understanding ideas: 戏剧与电影）
      id: 'eng-ch-g2-u4',
      name: 'Unit 4 Stage and screen',
      points: [
        {
          id: 'eng-g2u4-past-participle',
          name: '过去分词作定语与表语',
          keywords: ['过去分词', 'past participle', 'a broken window', 'be interested in', 'be based on'],
        },
        {
          id: 'eng-g2u4-ed-ing',
          name: '-ed 与 -ing 形容词辨析（bored / boring）',
          keywords: ['-ed形容词', '-ing形容词', 'bored boring', 'excited exciting', 'interesting interested'],
        },
        {
          id: 'eng-g2u4-film-vocab',
          name: '戏剧影视话题词汇',
          keywords: ['stage', 'screen', '京剧', 'Peking Opera', 'plot', 'character', 'audience', 'performance'],
        },
        {
          id: 'eng-g2u4-film-review',
          name: '影评写作与评价性语言',
          keywords: ['写影评', 'film review', 'highly recommend', 'worth watching', 'a must-see'],
        },
      ],
    },
    {
      // Unit 5 On the road（Understanding ideas: 旅行）
      id: 'eng-ch-g2-u5',
      name: 'Unit 5 On the road',
      points: [
        {
          id: 'eng-g2u5-present-participle',
          name: '现在分词作定语与表语',
          keywords: ['现在分词', 'present participle', 'the rising sun', 'a moving story', 'the situation is encouraging'],
        },
        {
          id: 'eng-g2u5-travel-vocab',
          name: '旅行与风土人情话题词汇',
          keywords: ['on the road', 'journey', 'destination', 'tourist attraction', 'souvenir', 'itinerary'],
        },
        {
          id: 'eng-g2u5-tense-agreement',
          name: '记叙文时态一致（一般过去 + 过去进行 + 过去完成）',
          keywords: ['时态一致', '过去完成时', 'had done', 'past perfect', 'while I was'],
        },
        {
          id: 'eng-g2u5-postcard',
          name: '明信片与旅行见闻写作',
          keywords: ['明信片', 'postcard', 'wish you were here', 'I have been to', 'on my trip'],
        },
      ],
    },
    {
      // Unit 6 Earth first（Understanding ideas: 环保）
      id: 'eng-ch-g2-u6',
      name: 'Unit 6 Earth first',
      points: [
        {
          id: 'eng-g2u6-future',
          name: '将来时的多种表达（will / be going to / be about to / be to do）',
          keywords: ['将来时', 'be about to', 'be to do', 'will be doing', 'is going to'],
        },
        {
          id: 'eng-g2u6-environment-vocab',
          name: '环境保护话题词汇',
          keywords: ['Earth first', 'environment', 'plastic waste', 'recycle', 'carbon emission', 'global warming', 'sustainable'],
        },
        {
          id: 'eng-g2u6-concession',
          name: '让步与转折结构（although / while / even if / despite）',
          keywords: ['although', 'even if', 'even though', 'despite', 'in spite of', 'while'],
        },
        {
          id: 'eng-g2u6-suggestion-letter',
          name: '建议信写作（I suggest that / It would be better to）',
          keywords: ['建议信', 'letter of suggestion', 'I suggest that', 'why not', 'it would be better to'],
        },
      ],
    },
  ],
}

/** 外研版（2019）必修第三册 —— 高一（部分地区高一下 / 高二上） */
const G3: Textbook = {
  grade: '高一',
  version: '外研版',
  chapters: [
    {
      // Unit 1 Knowing me, knowing you（Understanding ideas: 人际交往）
      id: 'eng-ch-g3-u1',
      name: 'Unit 1 Knowing me, knowing you',
      points: [
        {
          id: 'eng-g3u1-past-participle-adverbial',
          name: '过去分词作状语',
          keywords: ['过去分词作状语', 'past participle as adverbial', 'Faced with', 'Compared with', 'Seen from'],
        },
        {
          id: 'eng-g3u1-adj-suffix',
          name: '形容词后缀（-ful / -less / -ous / -ive）',
          keywords: ['形容词后缀', '-ful', '-less', '-ous', 'adjective suffix'],
        },
        {
          id: 'eng-g3u1-omission',
          name: '状语从句的省略（when (it is) done）',
          keywords: ['状语从句省略', 'when asked', 'if possible', 'while doing', 'omission'],
        },
        {
          id: 'eng-g3u1-interpersonal',
          name: '人际关系与情绪话题词汇',
          keywords: ['knowing me knowing you', 'get along with', 'misunderstanding', 'apologize', 'awkward', 'embarrassed'],
        },
        {
          id: 'eng-g3u1-advice-letter',
          name: '建议信 / 求助信写作（正式书信格式）',
          keywords: ['求助信', 'advice letter', 'Dear', 'Yours sincerely', 'I am writing to ask for'],
        },
      ],
    },
    {
      // Unit 2 Making a difference（Understanding ideas: 公益与善举）
      id: 'eng-ch-g3-u2',
      name: 'Unit 2 Making a difference',
      points: [
        {
          id: 'eng-g3u2-prep-rel',
          name: '介词 + which / whom 引导的定语从句',
          keywords: ['介词+which', 'in which', 'to whom', 'for which', 'on which'],
        },
        {
          id: 'eng-g3u2-nonrestrictive',
          name: '非限制性定语从句与 which 指代整句',
          keywords: ['非限制性定语从句', 'which 指代整句', ', which means', ', which made'],
        },
        {
          id: 'eng-g3u2-infinitive-adverbial',
          name: '不定式作目的状语与结果状语',
          keywords: ['不定式作状语', 'to help', 'only to find', 'in order to', 'so as to'],
        },
        {
          id: 'eng-g3u2-charity-vocab',
          name: '公益志愿与人物品质话题词汇',
          keywords: ['make a difference', 'charity', 'volunteer', 'donate', 'be committed to', 'devotion'],
        },
        {
          id: 'eng-g3u2-description',
          name: '人物介绍与事迹写作',
          keywords: ['人物介绍', 'a person who', 'be born in', 'devote oneself to', 'be awarded'],
        },
      ],
    },
    {
      // Unit 3 The world of science（Understanding ideas: 科学发现与实验）
      id: 'eng-ch-g3-u3',
      name: 'Unit 3 The world of science',
      points: [
        {
          id: 'eng-g3u3-passive',
          name: '被动语态的时态变化（含情态动词被动）',
          keywords: ['被动语态', '被动语态时态', 'can be done', 'is being done', 'had been done'],
        },
        {
          id: 'eng-g3u3-perfect-passive',
          name: '现在完成时的被动语态（has been done）',
          keywords: ['现在完成时被动', 'has been discovered', 'have been made', 'has been proved'],
        },
        {
          id: 'eng-g3u3-infinitive-attribute',
          name: '不定式作定语（the first to do / something to eat）',
          keywords: ['不定式作定语', 'the first to do', 'nothing to worry about', 'a way to do'],
        },
        {
          id: 'eng-g3u3-science-vocab',
          name: '科学发现与实验话题词汇',
          keywords: ['the world of science', 'experiment', 'discovery', 'theory', 'evidence', 'laboratory', 'invention'],
        },
        {
          id: 'eng-g3u3-sci-fi',
          name: '科幻故事写作与想象类表达',
          keywords: ['science fiction', '科幻', 'in the future', 'imagine that', 'robot'],
        },
      ],
    },
    {
      // Unit 4 Amazing art（Understanding ideas: 艺术与博物馆）
      id: 'eng-ch-g3-u4',
      name: 'Unit 4 Amazing art',
      points: [
        {
          id: 'eng-g3u4-participle',
          name: '分词作定语、表语与宾语补足语综合',
          keywords: ['分词作宾补', 'see sb doing', 'have sth done', 'find sth interesting', '现在分词与过去分词'],
        },
        {
          id: 'eng-g3u4-art-vocab',
          name: '艺术形式与博物馆话题词汇',
          keywords: ['amazing art', 'sculpture', 'painting', 'gallery', 'exhibition', 'masterpiece', 'calligraphy', '书法'],
        },
        {
          id: 'eng-g3u4-order',
          name: '描述方位与顺序的表达',
          keywords: ['in the centre of', 'on the left', 'in the background', 'at the top of', '方位描述'],
        },
        {
          id: 'eng-g3u4-art-review',
          name: '艺术品介绍与评论写作',
          keywords: ['艺术评论', 'art review', 'be famous for', 'be worth visiting', 'strike sb'],
        },
      ],
    },
    {
      // Unit 5 What an adventure!（Understanding ideas: 探险）
      id: 'eng-ch-g3-u5',
      name: 'Unit 5 What an adventure!',
      points: [
        {
          id: 'eng-g3u5-subjunctive-past',
          name: '虚拟语气（对过去的虚拟与 If only）',
          keywords: ['虚拟语气', 'subjunctive', 'if I had done', 'would have done', 'If only', 'wish I had'],
        },
        {
          id: 'eng-g3u5-adjunct',
          name: '形容词与副词的位置和比较等级',
          keywords: ['比较级', '最高级', 'the more the more', 'as as', 'much more', '形容词副词'],
        },
        {
          id: 'eng-g3u5-adventure-vocab',
          name: '探险与户外运动话题词汇',
          keywords: ['adventure', 'expedition', 'survive', 'challenge', 'wilderness', 'courage'],
        },
        {
          id: 'eng-g3u5-narrative',
          name: '冒险经历记叙文与情感描写',
          keywords: ['经历描写', 'I felt', 'to my surprise', 'all of a sudden', 'narrative'],
        },
      ],
    },
    {
      // Unit 6 Disaster and hope（Understanding ideas: 自然灾害与重建）
      id: 'eng-ch-g3-u6',
      name: 'Unit 6 Disaster and hope',
      points: [
        {
          id: 'eng-g3u6-indirect-speech',
          name: '间接引语（时态、人称与时间状语的转换）',
          keywords: ['间接引语', '间接引语时态', 'reported speech', 'said that', 'told me that', 'asked if'],
        },
        {
          id: 'eng-g3u6-subjunctive-past2',
          name: '虚拟语气（wish / would rather / as if）',
          keywords: ['wish 虚拟', 'would rather did', 'as if it were', 'if only I were', '虚拟语气'],
        },
        {
          id: 'eng-g3u6-passive-ing',
          name: '动词 -ing 形式的被动式（being done / having been done）',
          keywords: ['being done', 'having been done', '动名词被动', '非谓语被动'],
        },
        {
          id: 'eng-g3u6-disaster-vocab',
          name: '自然灾害与救援话题词汇',
          keywords: ['disaster', 'earthquake', 'flood', 'hurricane', 'rescue', 'relief', 'victim', 'rebuild'],
        },
        {
          id: 'eng-g3u6-hope',
          name: '灾难报道中的情感升华与希望表达',
          keywords: ['never lose hope', 'in the face of', 'pull together', 'rebuild our home', 'disaster relief'],
        },
      ],
    },
  ],
}

/* ============================================================
   高二 —— 选择性必修第一册 / 第二册 / 第三册
   ============================================================ */

/** 外研版（2019）选择性必修第一册 —— 高二上 */
const S1: Textbook = {
  grade: '高二',
  version: '外研版',
  chapters: [
    {
      // Unit 1 Laugh out loud!（Understanding ideas: 幽默与笑话）
      id: 'eng-ch-s1-u1',
      name: 'Unit 1 Laugh out loud!',
      points: [
        {
          id: 'eng-s1u1-infinitive',
          name: '不定式作主语、表语与宾语（含省略 to）',
          keywords: ['不定式', 'to do', '不定式省略to', 'make sb do', 'had better do'],
        },
        {
          id: 'eng-s1u1-modals',
          name: '情态动词表推测与责备（must / can not / should have done）',
          keywords: ['should have done', 'must have done', 'cannot have done', 'need not have done', '情态动词推测'],
        },
        {
          id: 'eng-s1u1-humour-vocab',
          name: '幽默、笑话与情感话题词汇',
          keywords: ['laugh out loud', 'humour', 'humor', 'joke', 'punch line', 'amusing', 'burst into laughter'],
        },
        {
          id: 'eng-s1u1-irony',
          name: '幽默语篇的讽刺与双关解读',
          keywords: ['irony', '讽刺', 'pun', '双关', 'play on words', 'sense of humour'],
        },
      ],
    },
    {
      // Unit 2 Onwards and upwards（Understanding ideas: 坚持与成功）
      id: 'eng-ch-s1-u2',
      name: 'Unit 2 Onwards and upwards',
      points: [
        {
          id: 'eng-s1u2-infinitive-perfect',
          name: '不定式的完成式与进行式（to have done / to be doing）',
          keywords: ['to have done', 'to be doing', '不定式完成式', 'seems to have'],
        },
        {
          id: 'eng-s1u2-subjunctive-wish',
          name: 'wish / if only 的虚拟语气',
          keywords: ['wish', 'if only', '虚拟语气', 'wish I could', 'I wish I had'],
        },
        {
          id: 'eng-s1u2-literature-vocab',
          name: '文学与励志话题词汇',
          keywords: ['onwards and upwards', 'novel', 'character', 'plot', 'author', 'autobiography', 'literature'],
        },
        {
          id: 'eng-s1u2-resilience',
          name: '坚持与成功主题写作（人物励志）',
          keywords: ['never give up', 'perseverance', 'overcome difficulties', "achieve one's dream", 'make it'],
        },
      ],
    },
    {
      // Unit 3 Faster, higher, stronger（Understanding ideas: 体育精神）
      id: 'eng-ch-s1-u3',
      name: 'Unit 3 Faster, higher, stronger',
      points: [
        {
          id: 'eng-s1u3-gerund',
          name: '动词 -ing 形式作主语、宾语与表语',
          keywords: ['动名词', 'doing', 'enjoy doing', 'be used to doing', 'look forward to doing'],
        },
        {
          id: 'eng-s1u3-gerund-perfect',
          name: '动词 -ing 的完成式与被动式',
          keywords: ['having done', 'being done', 'having been done', '-ing完成式'],
        },
        {
          id: 'eng-s1u3-sports-vocab',
          name: '竞技体育与奥运话题词汇',
          keywords: ['faster higher stronger', 'Olympic', 'champion', 'medal', 'record', 'coach', 'tournament'],
        },
        {
          id: 'eng-s1u3-participle-adverbial',
          name: '分词作状语（时间、原因、条件、伴随）',
          keywords: ['分词作状语', 'Having finished', 'Not knowing', '现在分词作状语', '过去分词作状语'],
        },
      ],
    },
    {
      // Unit 4 Meeting the muse（Understanding ideas: 艺术与灵感）
      id: 'eng-ch-s1-u4',
      name: 'Unit 4 Meeting the muse',
      points: [
        {
          id: 'eng-s1u4-passive-perfect',
          name: '被动语态综合（完成式、进行式与情态动词被动）',
          keywords: ['被动语态综合', 'has been done', 'is being done', 'must be done', '被动语态'],
        },
        {
          id: 'eng-s1u4-infinitive-passive',
          name: '不定式的被动式（to be done）',
          keywords: ['to be done', '不定式被动', 'to have been done', 'be said to be'],
        },
        {
          id: 'eng-s1u4-art-vocab',
          name: '艺术、音乐与灵感话题词汇',
          keywords: ['meeting the muse', 'muse', 'inspiration', 'sculptor', 'composer', 'work of art', 'masterpiece'],
        },
        {
          id: 'eng-s1u4-comparison',
          name: '比较结构（as … as / the more … the more）',
          keywords: ['as as', 'the more the more', '比较结构', 'no more than', 'not so as'],
        },
      ],
    },
    {
      // Unit 5 Revealing nature（Understanding ideas: 自然探索）
      id: 'eng-ch-s1-u5',
      name: 'Unit 5 Revealing nature',
      points: [
        {
          id: 'eng-s1u5-attributive',
          name: '定语从句综合（关系代词与关系副词的选择）',
          keywords: ['定语从句综合', '关系代词', '关系副词', 'whose', 'the reason why', 'the place where'],
        },
        {
          id: 'eng-s1u5-noun-clause',
          name: '名词性从句：that / whether / what 引导的主语与宾语从句',
          keywords: ['名词性从句', '主语从句', '宾语从句', 'whether', '名词性从句引导词', 'noun clause'],
        },
        {
          id: 'eng-s1u5-nature-vocab',
          name: '自然探索与生物话题词汇',
          keywords: ['revealing nature', 'species', 'evolve', 'evolution', 'Darwin', 'specimen', 'adapt to'],
        },
        {
          id: 'eng-s1u5-exposition',
          name: '科普说明文结构与写作',
          keywords: ['科普', 'exposition', '说明文', 'for example', 'according to', 'research shows'],
        },
      ],
    },
    {
      // Unit 6 Nurturing nature（Understanding ideas: 生态保护）
      id: 'eng-ch-s1-u6',
      name: 'Unit 6 Nurturing nature',
      points: [
        {
          id: 'eng-s1u6-it-cleft',
          name: '强调句型（It is … that …）',
          keywords: ['强调句', 'It is that', 'It was not until that', 'cleft sentence', '强调句型'],
        },
        {
          id: 'eng-s1u6-subjunctive-demand',
          name: '虚拟语气（suggest / demand / require + that + should do）',
          keywords: ['suggest that should', 'demand that', 'require that', 'it is necessary that', '虚拟语气should'],
        },
        {
          id: 'eng-s1u6-eco-vocab',
          name: '生态保护与生物多样性话题词汇',
          keywords: ['nurturing nature', 'ecosystem', 'biodiversity', 'conservation', 'sustainable', 'endangered'],
        },
        {
          id: 'eng-s1u6-proposal',
          name: '倡议书与环保提案写作',
          keywords: ['倡议书', 'proposal', 'call on sb to', 'it is high time that', 'protect the environment'],
        },
      ],
    },
  ],
}

/** 外研版（2019）选择性必修第二册 —— 高二下 */
const S2: Textbook = {
  grade: '高二',
  version: '外研版',
  chapters: [
    {
      // Unit 1 Growing up（Understanding ideas: 成长与责任）
      id: 'eng-ch-s2-u1',
      name: 'Unit 1 Growing up',
      points: [
        {
          id: 'eng-s2u1-future-perfect',
          name: '将来完成时与将来进行时',
          keywords: ['将来完成时', 'will have done', 'will be doing', 'by the end of next year'],
        },
        {
          id: 'eng-s2u1-adverbial-clause',
          name: '时间状语从句（by the time / as soon as / the moment）',
          keywords: ['by the time', 'as soon as', 'the moment', 'hardly when', 'no sooner than', '时间状语从句'],
        },
        {
          id: 'eng-s2u1-growing-vocab',
          name: '成长、责任与成年话题词汇',
          keywords: ['growing up', 'responsibility', 'adolescence', 'mature', 'independence', 'make a decision'],
        },
        {
          id: 'eng-s2u1-argument',
          name: '观点论证类议论文写作',
          keywords: ['议论文', 'argumentative', 'on the one hand', 'in conclusion', 'from my perspective'],
        },
      ],
    },
    {
      // Unit 2 Improving yourself（Understanding ideas: 自我提升）
      id: 'eng-ch-s2-u2',
      name: 'Unit 2 Improving yourself',
      points: [
        {
          id: 'eng-s2u2-subjunctive',
          name: '虚拟语气（if 条件句三种时态）',
          keywords: ['虚拟条件句', 'if I were', 'had done would have', 'were to', 'should do 虚拟'],
        },
        {
          id: 'eng-s2u2-imperative',
          name: '祈使句与 let 结构',
          keywords: ['祈使句', 'imperative', 'let us do', 'do not', 'never do'],
        },
        {
          id: 'eng-s2u2-self-vocab',
          name: '自我管理、习惯与成长话题词汇',
          keywords: ['improving yourself', 'self-control', 'habit', 'motivation', 'goal', 'persistence', 'time management'],
        },
        {
          id: 'eng-s2u2-pocket-money',
          name: '图表与调查数据描述写作',
          keywords: ['chart', 'percent', 'account for', 'the majority of', 'survey shows', '数据描述'],
        },
      ],
    },
    {
      // Unit 3 Times change!（Understanding ideas: 时代变迁）
      id: 'eng-ch-s2-u3',
      name: 'Unit 3 Times change!',
      points: [
        {
          id: 'eng-s2u3-passive-perfect',
          name: '被动语态综合运用（含完成式与进行式）',
          keywords: ['被动语态综合', 'have been done', 'is being done', '被动语态'],
        },
        {
          id: 'eng-s2u3-noun-clause',
          name: '同位语从句与 that 的用法',
          keywords: ['同位语从句', 'the fact that', 'the news that', 'appositive clause', 'idea that'],
        },
        {
          id: 'eng-s2u3-change-vocab',
          name: '社会变迁与科技发展话题词汇',
          keywords: ['times change', 'generation gap', 'urbanization', 'technology', 'traditional', 'modern life'],
        },
        {
          id: 'eng-s2u3-contrast',
          name: '古今对比类说明文写作',
          keywords: ['对比', 'compared with', 'in the past', 'nowadays', 'used to', 'whereas'],
        },
      ],
    },
    {
      // Unit 4 Breaking boundaries（Understanding ideas: 打破边界）
      id: 'eng-ch-s2-u4',
      name: 'Unit 4 Breaking boundaries',
      points: [
        {
          id: 'eng-s2u4-inversion',
          name: '倒装句（完全倒装与部分倒装）',
          keywords: ['倒装句', '完全倒装', '部分倒装', 'here comes', 'never have I', 'only when', 'not until'],
        },
        {
          id: 'eng-s2u4-concessive',
          name: '让步状语从句与 as / though 倒装',
          keywords: ['让步状语从句', 'as 倒装', 'though', 'no matter how', 'however', 'even though'],
        },
        {
          id: 'eng-s2u4-boundary-vocab',
          name: '跨文化、国界与全球议题词汇',
          keywords: ['breaking boundaries', 'boundary', 'cross-cultural', 'global', 'diversity', 'international'],
        },
        {
          id: 'eng-s2u4-speech',
          name: '演讲稿写作（称呼、呼告与排比）',
          keywords: ['演讲稿', 'speech', 'Ladies and gentlemen', 'Today I want to talk about', 'thank you for listening'],
        },
      ],
    },
    {
      // Unit 5 A delicate world（Understanding ideas: 生态脆弱性）
      id: 'eng-ch-s2-u5',
      name: 'Unit 5 A delicate world',
      points: [
        {
          id: 'eng-s2u5-ellipsis',
          name: '省略与替代（so / neither / nor / do so）',
          keywords: ['省略', '替代', 'so do I', 'neither do I', 'if so', 'if not', 'ellipsis'],
        },
        {
          id: 'eng-s2u5-prep',
          name: '介词与介词短语的搭配及辨析',
          keywords: ['介词搭配', 'in terms of', 'in spite of', 'due to', 'regardless of', 'preposition'],
        },
        {
          id: 'eng-s2u5-eco-vocab',
          name: '生态平衡与人类活动影响话题词汇',
          keywords: ['a delicate world', 'delicate', 'balance', 'ecosystem', 'human activity', 'die out', 'threaten'],
        },
        {
          id: 'eng-s2u5-report',
          name: '调查报告与问题解决类写作',
          keywords: ['调查报告', 'report', 'findings', 'solutions', 'as a result', 'in conclusion'],
        },
      ],
    },
    {
      // Unit 6 Survival（Understanding ideas: 生存）
      id: 'eng-ch-s2-u6',
      name: 'Unit 6 Survival',
      points: [
        {
          id: 'eng-s2u6-inversion-neg',
          name: '否定词前置引起的部分倒装（Never / Little / Hardly）',
          keywords: ['Never have I', 'Little did I', 'Hardly had', '否定词前置', '部分倒装'],
        },
        {
          id: 'eng-s2u6-modals-deduction',
          name: '情态动词表推测（对现在与过去的推测）',
          keywords: ['must be', 'may have done', 'cannot have done', '情态动词推测', 'might have'],
        },
        {
          id: 'eng-s2u6-survival-vocab',
          name: '生存、适应与极限环境话题词汇',
          keywords: ['survival', 'survive', 'adapt', 'extreme weather', 'shelter', 'resource', 'rescue'],
        },
        {
          id: 'eng-s2u6-summary',
          name: '语篇概括与读后缩写',
          keywords: ['概括', 'summary', 'in short', 'to sum up', 'main idea'],
        },
      ],
    },
  ],
}

/** 外研版（2019）选择性必修第三册 —— 高二（部分地区高二下 / 高三上） */
const S3: Textbook = {
  grade: '高二',
  version: '外研版',
  chapters: [
    {
      // Unit 1 Face values（Understanding ideas: 价值观与外表）
      id: 'eng-ch-s3-u1',
      name: 'Unit 1 Face values',
      points: [
        {
          id: 'eng-s3u1-subjunctive-past',
          name: '虚拟语气（对过去与混合时间条件的虚拟）',
          keywords: ['混合虚拟', 'if I had done I would', 'would have done', '虚拟语气过去'],
        },
        {
          id: 'eng-s3u1-prep-idiom',
          name: '介词短语与固定搭配（in terms of / at the cost of）',
          keywords: ['in terms of', 'at the cost of', 'in the face of', 'for the sake of', '固定搭配'],
        },
        {
          id: 'eng-s3u1-values-vocab',
          name: '外表、价值观与社会评价话题词汇',
          keywords: ['face values', 'appearance', 'values', 'judge by', 'self-image', 'beauty', 'reputation'],
        },
        {
          id: 'eng-s3u1-career-plan',
          name: '职业规划与个人陈述写作',
          keywords: ['职业规划', 'career plan', 'personal statement', 'I am good at', 'in the future I want to'],
        },
      ],
    },
    {
      // Unit 2 A life's work（Understanding ideas: 毕生事业）
      id: 'eng-ch-s3-u2',
      name: "Unit 2 A life's work",
      points: [
        {
          id: 'eng-s3u2-passive-report',
          name: '被动语态在说明与报道中的使用',
          keywords: ['被动语态', 'it is reported that', 'is said to', '被动语态报道'],
        },
        {
          id: 'eng-s3u2-relative',
          name: '定语从句与同位语从句的辨析',
          keywords: ['定语从句与同位语从句', 'that 区别', 'the news that', 'the news which'],
        },
        {
          id: 'eng-s3u2-work-vocab',
          name: '职业、事业与工匠精神话题词汇',
          keywords: ["a life's work", 'career', 'profession', 'craftsman', 'dedication', 'devote to', 'lifelong'],
        },
        {
          id: 'eng-s3u2-biography',
          name: '人物传记写作（时间顺序）',
          keywords: ['人物传记', 'biography', 'was born in', 'graduated from', 'devoted himself to'],
        },
      ],
    },
    {
      // Unit 3 War and peace（Understanding ideas: 战争与和平）
      id: 'eng-ch-s3-u3',
      name: 'Unit 3 War and peace',
      points: [
        {
          id: 'eng-s3u3-inversion-only',
          name: 'only + 状语前置引起的倒装',
          keywords: ['only 倒装', 'Only then did', 'Only when', 'only in this way'],
        },
        {
          id: 'eng-s3u3-verb-tenses',
          name: '时态综合（一般过去、过去完成与过去进行）',
          keywords: ['时态综合', 'had done', 'was doing when', 'past perfect', '一般过去时'],
        },
        {
          id: 'eng-s3u3-war-vocab',
          name: '战争、和平与历史记忆话题词汇',
          keywords: ['war and peace', 'wartime', 'peace', 'battle', 'soldier', 'memorial', 'sacrifice'],
        },
        {
          id: 'eng-s3u3-narrative',
          name: '历史叙事与反思类写作',
          keywords: ['历史叙事', 'remind sb of', 'never forget', 'in memory of', 'reflect on'],
        },
      ],
    },
    {
      // Unit 4 A glimpse of the future（Understanding ideas: 未来展望）
      id: 'eng-ch-s3-u4',
      name: 'Unit 4 A glimpse of the future',
      points: [
        {
          id: 'eng-s3u4-subjunctive-wish',
          name: '虚拟语气（wish / would rather / it is high time）',
          keywords: ['wish 虚拟', 'would rather', 'it is high time that', 'If only', '虚拟语气'],
        },
        {
          id: 'eng-s3u4-connector',
          name: '逻辑连接词与语篇衔接（moreover / nevertheless / therefore）',
          keywords: ['moreover', 'nevertheless', 'therefore', 'furthermore', 'in addition', 'as a consequence'],
        },
        {
          id: 'eng-s3u4-future-vocab',
          name: '未来科技与人工智能话题词汇',
          keywords: ['a glimpse of the future', 'artificial intelligence', 'AI', 'robot', 'innovation', 'predict'],
        },
        {
          id: 'eng-s3u4-prediction',
          name: '预测与展望类写作',
          keywords: ['预测', 'it is predicted that', 'by 2050', 'is likely to', 'in the years to come'],
        },
      ],
    },
    {
      // Unit 5 Learning from nature（Understanding ideas: 向自然学习）
      id: 'eng-ch-s3-u5',
      name: 'Unit 5 Learning from nature',
      points: [
        {
          id: 'eng-s3u5-subjunctive-mix',
          name: '虚拟语气综合（条件句、宾语从句与状语从句）',
          keywords: ['虚拟语气综合', 'were it not for', 'but for', 'otherwise', 'should have done'],
        },
        {
          id: 'eng-s3u5-word-formation',
          name: '词性转换与派生词（名词 / 形容词 / 副词）',
          keywords: ['词性转换', '派生词', '名词变动词', '形容词变副词', 'word formation'],
        },
        {
          id: 'eng-s3u5-nature-vocab',
          name: '仿生、自然智慧与可持续话题词汇',
          keywords: ['learning from nature', 'biomimicry', '仿生', 'inspiration from nature', 'sustainable design'],
        },
        {
          id: 'eng-s3u5-abstract',
          name: '摘要与研究报告写作',
          keywords: ['摘要', 'abstract', 'research', 'the purpose of this report', 'conclusion'],
        },
      ],
    },
    {
      // Unit 6 Nature in words（Understanding ideas: 自然文学）
      id: 'eng-ch-s3-u6',
      name: 'Unit 6 Nature in words',
      points: [
        {
          id: 'eng-s3u6-ellipsis',
          name: '省略与倒装在文学语篇中的运用',
          keywords: ['省略', '倒装', '文学语篇', 'poetic inversion', 'ellipsis'],
        },
        {
          id: 'eng-s3u6-emphasis',
          name: '强调手段（do 强调、强调句与倒装）',
          keywords: ['强调句', 'do 强调', 'I do believe', 'It is that', 'emphasis'],
        },
        {
          id: 'eng-s3u6-nature-vocab',
          name: '自然描写与文学修辞话题词汇',
          keywords: ['nature in words', 'imagery', 'metaphor', 'personification', '修辞', 'scenery'],
        },
        {
          id: 'eng-s3u6-description',
          name: '写景状物类描写文写作',
          keywords: ['写景', 'description', 'the sun rose', 'a gentle breeze', 'five senses'],
        },
      ],
    },
  ],
}

/* ============================================================
   高三 —— 选择性必修第四册（收尾）+ 高考一轮复习专题
   ------------------------------------------------------------
   ⚠️ 高三这一本教材里放了两个东西：
      · `s4` 那 6 个 Unit 是**教材的真实单元**（外研版最后一册）；
      · `r3-` 那 4 章是**一轮复习专题**（语法专题 / 构词法 / 题型 / 写作），
        不是课本目录、是高考复习的通用板块 —— 高三本来就以复习为主，
        错题归因时这两类要能分开挂，所以分成独立章节。
      章节名里 `一轮复习` 前缀就是给老师看的这个区分，别当成教材单元。
   ============================================================ */

/** 外研版（2019）选择性必修第四册 —— 高三 */
const S4: Textbook = {
  grade: '高三',
  version: '外研版',
  chapters: [
    {
      // Unit 1 Looking forwards（Understanding ideas: 面向未来）
      id: 'eng-ch-s4-u1',
      name: 'Unit 1 Looking forwards',
      points: [
        {
          id: 'eng-s4u1-noun-clause',
          name: '名词性从句综合（主、宾、表、同位语从句）',
          keywords: ['名词性从句', '主语从句', '宾语从句', '表语从句', '同位语从句', 'whether'],
        },
        {
          id: 'eng-s4u1-future-forms',
          name: '将来时态综合（will / be to do / be about to）',
          keywords: ['将来时综合', 'be to do', 'be about to', 'will have done', 'in the future'],
        },
        {
          id: 'eng-s4u1-forward-vocab',
          name: '未来规划与人生选择话题词汇',
          keywords: ['looking forwards', 'look forward', 'career choice', 'decision', 'opportunity', 'plan for'],
        },
        {
          id: 'eng-s4u1-formal-letter',
          name: '申请信与正式邮件写作',
          keywords: ['申请信', 'application letter', 'I am writing to apply for', 'Yours faithfully', 'enclose'],
        },
      ],
    },
    {
      // Unit 2 Lessons in life（Understanding ideas: 人生启示）
      id: 'eng-ch-s4-u2',
      name: 'Unit 2 Lessons in life',
      points: [
        {
          id: 'eng-s4u2-relative-nonrestrictive',
          name: '非限制性定语从句与 which 指代整句',
          keywords: ['非限制性定语从句', ', which', ', who', 'which 指代整句', 'some of which'],
        },
        {
          id: 'eng-s4u2-gerund-subject',
          name: '动名词与不定式作主语的辨析',
          keywords: ['动名词作主语', '不定式作主语', 'Doing is', 'To do is', 'it is no use doing'],
        },
        {
          id: 'eng-s4u2-life-vocab',
          name: '人生感悟与经验教训话题词汇',
          keywords: ['lessons in life', 'lesson', 'experience', 'regret', 'learn from', 'wisdom'],
        },
        {
          id: 'eng-s4u2-reflective',
          name: '感悟类夹叙夹议写作',
          keywords: ['夹叙夹议', 'reflection', 'from this I learned', 'what impressed me most', 'in retrospect'],
        },
      ],
    },
    {
      // Unit 3 The world meets China（Understanding ideas: 中国与世界）
      id: 'eng-ch-s4-u3',
      name: 'Unit 3 The world meets China',
      points: [
        {
          id: 'eng-s4u3-inversion',
          name: '倒装句综合（否定词前置、only、as / though）',
          keywords: ['倒装句综合', 'never have I', 'only then did', 'young as he is', '部分倒装'],
        },
        {
          id: 'eng-s4u3-subjunctive',
          name: '虚拟语气综合复习',
          keywords: ['虚拟语气综合', 'if 虚拟', 'wish', 'would rather', 'as if', 'it is high time'],
        },
        {
          id: 'eng-s4u3-china-vocab',
          name: '中国文化对外传播话题词汇',
          keywords: ['the world meets China', 'traditional Chinese culture', 'cultural exchange', 'heritage', 'civilization'],
        },
        {
          id: 'eng-s4u3-culture',
          name: '文化介绍与跨文化比较写作',
          keywords: ['文化介绍', 'cultural differences', 'compared with', 'in Chinese culture', 'it is customary to'],
        },
      ],
    },
    {
      // Unit 4 Everyday economics（Understanding ideas: 日常经济生活）
      id: 'eng-ch-s4-u4',
      name: 'Unit 4 Everyday economics',
      points: [
        {
          id: 'eng-s4u4-adverbial-clause',
          name: '状语从句综合（时间、条件、原因、结果、目的）',
          keywords: ['状语从句', '条件状语从句', 'as long as', 'so that', 'now that', 'in case', 'unless'],
        },
        {
          id: 'eng-s4u4-passive-review',
          name: '被动语态与主动语态的选用',
          keywords: ['被动语态', '主动语态', '被动语态复习', 'by 短语'],
        },
        {
          id: 'eng-s4u4-economics-vocab',
          name: '消费、理财与经济生活话题词汇',
          keywords: ['everyday economics', 'economy', 'budget', 'consume', 'consumer', 'purchase', 'brand'],
        },
        {
          id: 'eng-s4u4-chart',
          name: '图表作文与数据说明写作',
          keywords: ['图表作文', 'chart', 'figure', 'increase by', 'account for', 'as is shown in the chart'],
        },
      ],
    },
    {
      // Unit 5 Into the unknown（Understanding ideas: 探索未知）
      id: 'eng-ch-s4-u5',
      name: 'Unit 5 Into the unknown',
      points: [
        {
          id: 'eng-s4u5-subjunctive-wish',
          name: '虚拟语气在名词性从句中的使用（suggest / demand / wish）',
          keywords: ['虚拟语气名词性从句', 'suggest that should', 'demand that', 'wish that', 'would rather that'],
        },
        {
          id: 'eng-s4u5-pronunciation',
          name: '语音与重音（句子重音、语调与弱读）',
          keywords: ['语音', '重音', '语调', 'stress', 'intonation', 'pronunciation', '弱读'],
        },
        {
          id: 'eng-s4u5-unknown-vocab',
          name: '探索未知与科学精神话题词汇',
          keywords: ['into the unknown', 'unknown', 'explore', 'discovery', 'curiosity', 'frontier', 'investigate'],
        },
        {
          id: 'eng-s4u5-argument',
          name: '观点表达与辩论类写作',
          keywords: ['辩论', 'debate', 'argue that', 'on the contrary', 'support the idea', 'oppose'],
        },
      ],
    },
    {
      // Unit 6 Space and beyond（Understanding ideas: 太空探索）
      id: 'eng-ch-s4-u6',
      name: 'Unit 6 Space and beyond',
      points: [
        {
          id: 'eng-s4u6-review-grammar',
          name: '高中语法综合运用（时态、语态与非谓语综合）',
          keywords: ['语法综合', '语法填空', '时态语态', '非谓语', '综合运用'],
        },
        {
          id: 'eng-s4u6-space-vocab',
          name: '太空探索与科技前沿话题词汇',
          keywords: ['space and beyond', 'spacecraft', 'astronaut', 'orbit', 'satellite', 'universe', 'launch'],
        },
        {
          id: 'eng-s4u6-imagination',
          name: '想象类与科幻类写作',
          keywords: ['想象作文', 'imagine', 'what if', 'in the year 2100', 'science fiction'],
        },
        {
          id: 'eng-s4u6-project',
          name: '项目式学习与口头展示（presenting ideas）',
          keywords: ['presenting ideas', '口头展示', 'in my presentation', 'to conclude', 'any questions'],
        },
      ],
    },
    {
      // 一轮复习专题 ① 语法专题
      id: 'eng-ch-r3-grammar',
      name: '一轮复习：语法专题',
      points: [
        {
          id: 'eng-r3-noun-article',
          name: '名词、冠词与代词',
          keywords: ['冠词', '定冠词', '不定冠词', 'a an the', '代词', 'it 用法', '名词单复数'],
        },
        {
          id: 'eng-r3-tense-voice',
          name: '时态与语态综合',
          keywords: ['时态', '语态', '一般现在时', '现在完成时', '过去完成时', '将来时', '被动语态'],
        },
        {
          id: 'eng-r3-attributive-clause',
          name: '定语从句（关系代词、关系副词与介词 + which）',
          keywords: ['定语从句', '关系代词', '关系副词', '介词+which', 'whose', '非限制性定语从句'],
        },
        {
          id: 'eng-r3-adverbial-clause',
          name: '状语从句（时间、地点、条件、让步、结果、目的、方式）',
          keywords: ['状语从句', '让步状语从句', '条件状语从句', '结果状语从句', 'as if', 'no matter'],
        },
        {
          id: 'eng-r3-noun-clause',
          name: '名词性从句（主语、宾语、表语、同位语）',
          keywords: ['名词性从句', '主语从句', '宾语从句', '表语从句', '同位语从句', 'whether'],
        },
        {
          id: 'eng-r3-nonfinite',
          name: '非谓语动词作主语、宾语与表语',
          keywords: ['非谓语动词', '动名词', '不定式', 'to do', 'doing', 'it is no use doing'],
        },
        {
          id: 'eng-r3-nonfinite-adverbial',
          name: '非谓语动词作状语与定语',
          keywords: ['非谓语作状语', '非谓语作定语', '现在分词作状语', '过去分词作定语', 'having done', 'to be done'],
        },
        {
          id: 'eng-r3-nonfinite-complement',
          name: '非谓语动词作宾语补足语',
          keywords: ['宾语补足语', 'see sb do', 'see sb doing', 'have sth done', 'make oneself understood'],
        },
        {
          id: 'eng-r3-inversion',
          name: '倒装句与强调句',
          keywords: ['倒装句', '强调句', 'It is that', 'only 倒装', 'never have I', '部分倒装'],
        },
        {
          id: 'eng-r3-subjunctive',
          name: '虚拟语气',
          keywords: ['虚拟语气', 'if 虚拟条件句', 'wish', 'would rather', 'as if', 'it is high time', 'should 虚拟'],
        },
        {
          id: 'eng-r3-agreement',
          name: '主谓一致与特殊句式',
          keywords: ['主谓一致', 'there be', '就近原则', 'either or', 'as well as', 'each of'],
        },
        {
          id: 'eng-r3-formation-punct',
          name: '构词法、大小写与标点',
          keywords: ['构词法', '词性转换', '派生', '合成', '大小写', '标点', 'punctuation'],
        },
      ],
    },
    {
      // 一轮复习专题 ② 高考题型突破
      id: 'eng-ch-r3-exam-skills',
      name: '一轮复习：高考题型突破',
      points: [
        {
          id: 'eng-r3-listening',
          name: '听力理解（数字、地点、意图与推理）',
          keywords: ['听力', 'listening', 'what does the man mean', 'where does the conversation', '听力理解'],
        },
        {
          id: 'eng-r3-reading',
          name: '阅读理解（细节、推断、主旨与词义猜测）',
          keywords: ['阅读理解', 'reading comprehension', 'main idea', 'infer', 'the author implies', 'the underlined word'],
        },
        {
          id: 'eng-r3-cloze',
          name: '完形填空（语境逻辑与词汇复现）',
          keywords: ['完形填空', 'cloze', '上下文逻辑', '根据语境', '完形'],
        },
        {
          id: 'eng-r3-seven-five',
          name: '七选五（语篇衔接与逻辑关系）',
          keywords: ['七选五', '阅读填空', '语篇衔接', 'however', 'for example', 'in addition'],
        },
        {
          id: 'eng-r3-grammar-fill',
          name: '语法填空（有提示词与无提示词）',
          keywords: ['语法填空', 'grammar filling', '有提示词', '无提示词', '括号内'],
        },
        {
          id: 'eng-r3-correction',
          name: '短文改错（十大考点）',
          keywords: ['短文改错', '改错', 'correction', '多一词', '缺一词', '错一词'],
        },
      ],
    },
    {
      // 一轮复习专题 ③ 写作专项
      id: 'eng-ch-r3-writing',
      name: '一轮复习：写作专项',
      points: [
        {
          id: 'eng-r3-letter',
          name: '应用文：书信与邮件（建议、邀请、申请、感谢）',
          keywords: ['应用文', '书信', 'Li Hua', 'Dear', 'Yours', 'I am writing to'],
        },
        {
          id: 'eng-r3-notice-speech',
          name: '应用文：通知、演讲稿与倡议书',
          keywords: ['通知', 'notice', '演讲稿', 'speech', '倡议书', 'call on'],
        },
        {
          id: 'eng-r3-continuation',
          name: '读后续写（情节推进、伏笔照应与段落衔接）',
          keywords: ['读后续写', '续写', 'paragraph 1', 'paragraph 2', '情节', '伏笔'],
        },
        {
          id: 'eng-r3-description',
          name: '读后续写（动作、心理与神态描写）',
          keywords: ['动作描写', '心理描写', '神态描写', 'with tears in his eyes', 'heart pounding', '描写'],
        },
        {
          id: 'eng-r3-cohesion',
          name: '连贯与衔接（连接词、代词指代与句式变化）',
          keywords: ['连贯', '衔接', '连接词', 'cohesion', 'transition', '句式变化'],
        },
      ],
    },
    {
      // 一轮复习专题 ④ 词汇与语法基础（积累类，题目打标常命中的落点）
      id: 'eng-ch-r3-vocab',
      name: '一轮复习：词汇与语法基础',
      points: [
        {
          id: 'eng-r3-core-words',
          name: '高考核心词汇与一词多义',
          keywords: ['核心词汇', '一词多义', '熟词生义', 'vocabulary', 'word meaning'],
        },
        {
          id: 'eng-r3-collocation',
          name: '固定搭配与短语（动词 + 介词）',
          keywords: ['固定搭配', '动词短语', 'collocation', 'phrasal verb', '介词搭配'],
        },
        {
          id: 'eng-r3-word-discrimination',
          name: '近义词辨析（affect / effect，rise / raise 等）',
          keywords: ['近义词辨析', '词义辨析', 'affect effect', 'rise raise', 'lie lay'],
        },
      ],
    },
  ],
}

export const ENGLISH_TREE: KnowledgeTree = {
  subject: 'english',
  textbooks: [G1, G2, G3, S1, S2, S3, S4],
}
