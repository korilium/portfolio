# Blackjack With RL 

*Date: 2025-01-01*

We have all played blackjack before. The goal of the game is to beat the bank (casino) in getting as close the the number 21 but not overreaching it. For a single deck you would have 52 cards and the number of possible two-card hands are: 



$ player: \binom{52}{2} = 1,326$ 



while for the bank this would be: 



$ bank: \binom{50}{2}= 1,225$ 

In total you would have a total of the following possible states: 

$$ \sum_{n=2}^{11} \binom{52}{n} \times \sum_{m=2}^{11} \binom{52-2}{m}$$

where $n$ are the number of cards in the player hands and $m$ are the number of cards in the banks hands. 

this is an astronomical large number to model and therefore we need to make an abstraction of the game and only consider the total card value of the banks hands and the players hands. The total amount of states then become more manageable: 

$ total States = 20 \times 20 = 400$ 

As the minimum total card value is 4 and the maximum total card value is 21. Lastly, all the states above 21 are considered busts. This gives a total state of 19 per hand  

We therefore only consider the total value of cards and make an abstraction of reality. 

We then create the environements rules and the strategy of the bank. 